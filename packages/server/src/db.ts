import { DatabaseSync } from 'node:sqlite';
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
  seed: string;
  players: string;
  result: string;
  replay: string;
  started_at: number;
  finished_at: number;
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
      CREATE TABLE IF NOT EXISTS game_players (
        game_id TEXT NOT NULL, bot_id TEXT NOT NULL, seat INTEGER NOT NULL, is_landlord INTEGER NOT NULL,
        score INTEGER NOT NULL, win INTEGER NOT NULL, timeouts INTEGER NOT NULL,
        PRIMARY KEY (game_id, seat)
      );
      CREATE INDEX IF NOT EXISTS game_players_bot ON game_players(bot_id);
    `);
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
      this.db.prepare('INSERT INTO games (id, room_id, seed, players, result, replay, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.room_id, row.seed, row.players, row.result, row.replay, row.started_at, row.finished_at);
      const st = this.db.prepare('INSERT INTO game_players (game_id, bot_id, seat, is_landlord, score, win, timeouts) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const p of players) st.run(row.id, p.bot_id, p.seat, p.is_landlord, p.score, p.win, p.timeouts);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  game(id: string): GameRow | undefined {
    return this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
  }

  recentGames(limit: number, botId?: string): Omit<GameRow, 'replay'>[] {
    const cols = 'g.id, g.room_id, g.seed, g.players, g.result, g.started_at, g.finished_at';
    if (botId) {
      return this.db.prepare(`SELECT ${cols} FROM games g JOIN game_players p ON p.game_id = g.id WHERE p.bot_id = ? ORDER BY g.finished_at DESC LIMIT ?`)
        .all(botId, limit) as unknown as Omit<GameRow, 'replay'>[];
    }
    return this.db.prepare(`SELECT ${cols} FROM games g ORDER BY g.finished_at DESC LIMIT ?`).all(limit) as unknown as Omit<GameRow, 'replay'>[];
  }

  leaderboard() {
    return this.db.prepare(`
      SELECT b.id AS bot_id, b.name, b.kind, COUNT(*) AS games, SUM(p.win) AS wins,
        SUM(p.is_landlord) AS landlord_games, SUM(p.is_landlord * p.win) AS landlord_wins,
        SUM(p.score) AS score, SUM(p.timeouts) AS timeouts
      FROM game_players p JOIN bots b ON b.id = p.bot_id
      GROUP BY b.id ORDER BY score DESC, wins DESC LIMIT 200
    `).all();
  }
}
