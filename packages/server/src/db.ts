import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BotRow {
  id: string;
  name: string;
  kind: 'bot' | 'human';
  token_hash: string;
  created_at: number;
}

export interface GamePlayerRow {
  bot_id: string;
  seat: number;
  is_landlord: number;
  score: number;
  win: number;
  timeouts: number;
}

export interface GameRow {
  id: string;
  room_id: string;
  game_type: string;
  seed: string;
  players: string;
  result: string;
  replay: string;
  started_at: number;
  finished_at: number;
}

/** Replays are stored brotli-compressed (about 1/10 of the JSON); rows written before that
 * hold the JSON text until {@link Db.packOldReplays} gets to them. */
function packReplay(json: string): Uint8Array {
  return brotliCompressSync(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
}

function unpackReplay(v: unknown): string {
  return typeof v === 'string' ? v : brotliDecompressSync(v as Uint8Array).toString('utf8');
}

/** Filters for {@link Db.recentGames}; all optional and combined with AND. */
export interface GameFilter {
  botId?: string;
  gameType?: string;
  roomId?: string;
}

export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seed TEXT NOT NULL, players TEXT NOT NULL,
        result TEXT NOT NULL, replay TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_finished ON games(finished_at DESC);
      CREATE INDEX IF NOT EXISTS games_room ON games(room_id, finished_at DESC);
      CREATE TABLE IF NOT EXISTS game_players (
        game_id TEXT NOT NULL, bot_id TEXT NOT NULL, seat INTEGER NOT NULL, is_landlord INTEGER NOT NULL,
        score INTEGER NOT NULL, win INTEGER NOT NULL, timeouts INTEGER NOT NULL,
        PRIMARY KEY (game_id, seat)
      );
      CREATE INDEX IF NOT EXISTS game_players_bot ON game_players(bot_id);
    `);
    // Added with multi-game support; older databases only hold 3-player Dou Dizhu games.
    for (const table of ['games', 'game_players']) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'game_type')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN game_type TEXT NOT NULL DEFAULT 'ddz'`);
    }
    // Per-type game lists: newest first without scanning (and reading replays of) other types.
    this.db.exec('CREATE INDEX IF NOT EXISTS games_type ON games(game_type, finished_at DESC)');
    // Leaderboard totals, kept up to date on every insert so reading them never scans
    // game_players. Filled from game_players once when the table is new.
    const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_stats'").get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        bot_id TEXT NOT NULL, game_type TEXT NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL,
        landlord_games INTEGER NOT NULL, landlord_wins INTEGER NOT NULL, score INTEGER NOT NULL,
        timeouts INTEGER NOT NULL, PRIMARY KEY (bot_id, game_type)
      );
    `);
    if (fresh) {
      this.db.exec(`
        INSERT INTO bot_stats
        SELECT bot_id, game_type, COUNT(*), SUM(win), SUM(is_landlord), SUM(is_landlord * win), SUM(score), SUM(timeouts)
        FROM game_players GROUP BY bot_id, game_type
      `);
    }
  }

  insertBot(row: BotRow) {
    this.db.prepare('INSERT INTO bots (id, name, kind, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.kind, row.token_hash, row.created_at);
  }

  botByName(name: string): BotRow | undefined {
    return this.db.prepare('SELECT * FROM bots WHERE name = ?').get(name) as BotRow | undefined;
  }

  botByTokenHash(hash: string): BotRow | undefined {
    return this.db.prepare('SELECT * FROM bots WHERE token_hash = ?').get(hash) as BotRow | undefined;
  }

  insertGame(row: GameRow, players: GamePlayerRow[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO games (id, room_id, game_type, seed, players, result, replay, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.room_id, row.game_type, row.seed, row.players, row.result, packReplay(row.replay), row.started_at, row.finished_at);
      const st = this.db.prepare('INSERT INTO game_players (game_id, game_type, bot_id, seat, is_landlord, score, win, timeouts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const stats = this.db.prepare(`
        INSERT INTO bot_stats VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT (bot_id, game_type) DO UPDATE SET games = games + 1, wins = wins + excluded.wins,
          landlord_games = landlord_games + excluded.landlord_games, landlord_wins = landlord_wins + excluded.landlord_wins,
          score = score + excluded.score, timeouts = timeouts + excluded.timeouts
      `);
      for (const p of players) {
        st.run(row.id, row.game_type, p.bot_id, p.seat, p.is_landlord, p.score, p.win, p.timeouts);
        stats.run(p.bot_id, row.game_type, p.win, p.is_landlord, p.is_landlord * p.win, p.score, p.timeouts);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  game(id: string): GameRow | undefined {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row && ({ ...row, replay: unpackReplay(row.replay) } as GameRow);
  }

  /** Compress up to `batch` replays still stored as text; returns how many were done. */
  packOldReplays(batch: number): number {
    const rows = this.db.prepare("SELECT id, replay FROM games WHERE typeof(replay) = 'text' LIMIT ?").all(batch) as { id: string; replay: string }[];
    if (rows.length === 0) return 0;
    const st = this.db.prepare('UPDATE games SET replay = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const r of rows) st.run(packReplay(r.replay), r.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rows.length;
  }

  /** Newest first. With `before` (a game id), only games that finished before that one. */
  recentGames(limit: number, filter: GameFilter = {}, before?: { id: string; finished_at: number }): Omit<GameRow, 'replay'>[] {
    const { botId, gameType, roomId } = filter;
    const cols = 'g.id, g.room_id, g.game_type, g.seed, g.players, g.result, g.started_at, g.finished_at';
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (botId) {
      where.push('g.id IN (SELECT game_id FROM game_players WHERE bot_id = ?)');
      args.push(botId);
    }
    if (gameType) {
      where.push('g.game_type = ?');
      args.push(gameType);
    }
    if (roomId) {
      where.push('g.room_id = ?');
      args.push(roomId);
    }
    if (before) {
      where.push('(g.finished_at < ? OR (g.finished_at = ? AND g.id < ?))');
      args.push(before.finished_at, before.finished_at, before.id);
    }
    const sql = `SELECT ${cols} FROM games g ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.finished_at DESC, g.id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as unknown as Omit<GameRow, 'replay'>[];
  }

  leaderboard(gameType = 'ddz') {
    return this.db.prepare(`
      SELECT b.id AS bot_id, b.name, b.kind, s.games, s.wins, s.landlord_games, s.landlord_wins, s.score, s.timeouts
      FROM bot_stats s JOIN bots b ON b.id = s.bot_id
      WHERE s.game_type = ?
      ORDER BY s.score DESC, s.wins DESC LIMIT 200
    `).all(gameType);
  }
}
