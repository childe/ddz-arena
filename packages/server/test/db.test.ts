import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { Db } from '../src/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'ddz-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function addGame(db: Db, id: string, gameType: string, rows: [string, number, number, number][], finishedAt = 2, replay = '{}') {
  db.insertGame(
    { id, room_id: 'r_1', game_type: gameType, seed: 's', players: '[]', result: '{}', replay, started_at: 1, finished_at: finishedAt },
    rows.map(([bot_id, is_landlord, win, score], seat) => ({ bot_id, seat, is_landlord, win, score, timeouts: 0 }) as never),
  );
}

describe('leaderboard totals', () => {
  it('are kept per game type on insert and rebuilt from game_players for an old database', () => {
    const path = join(dir, 'a.db');
    let db = new Db(path);
    for (const name of ['a', 'b', 'c']) db.insertBot({ id: name, name, kind: 'bot', token_hash: name, created_at: 0 });
    addGame(db, 'g1', 'ddz', [['a', 1, 1, 4], ['b', 0, 0, -2], ['c', 0, 0, -2]]);
    addGame(db, 'g2', 'ddz', [['a', 1, 0, -2], ['b', 0, 1, 1], ['c', 0, 1, 1]]);
    addGame(db, 'g3', 'ddz4', [['b', 1, 1, 6]]);
    const a = db.leaderboard('ddz').find((r: any) => r.bot_id === 'a');
    expect(a).toMatchObject({ games: 2, wins: 1, landlord_games: 2, landlord_wins: 1, score: 2 });
    expect(db.leaderboard('ddz4')).toEqual([expect.objectContaining({ bot_id: 'b', games: 1, score: 6 })]);
    const before = JSON.stringify([db.leaderboard('ddz'), db.leaderboard('ddz4')]);
    // A database from before bot_stats existed: the table is rebuilt on open.
    new DatabaseSync(path).exec('DROP TABLE bot_stats');
    db = new Db(path);
    expect(JSON.stringify([db.leaderboard('ddz'), db.leaderboard('ddz4')])).toBe(before);
  });
});

describe('replays and paging', () => {
  it('stores replays compressed, packs old text replays and pages through every game', () => {
    const path = join(dir, 'b.db');
    const db = new Db(path);
    const replay = JSON.stringify({ history: Array.from({ length: 200 }, (_, i) => ({ seat: i % 3, cards: ['3S', '4H'] })) });
    // g0..g24; g10 and g11 finish at the same time (ties are broken by id).
    for (let i = 0; i < 25; i++) addGame(db, `g${String(i).padStart(2, '0')}`, 'ddz', [], i === 11 ? 10 : i, replay);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT typeof(replay) t, length(replay) n FROM games WHERE id = 'g00'").get()).toMatchObject({ t: 'blob' });
    expect((raw.prepare("SELECT length(replay) n FROM games WHERE id = 'g00'").get() as { n: number }).n).toBeLessThan(replay.length / 5);
    expect(db.game('g00')!.replay).toBe(replay);
    // A row from before compression is read as is, then packed.
    raw.prepare("UPDATE games SET replay = ? WHERE id = 'g01'").run(replay);
    expect(db.game('g01')!.replay).toBe(replay);
    expect(db.packOldReplays(100)).toBe(1);
    expect(db.packOldReplays(100)).toBe(0);
    expect(db.game('g01')!.replay).toBe(replay);
    // Paging newest first, 7 at a time, reaches every game exactly once.
    const seen: string[] = [];
    let before: { id: string; finished_at: number } | undefined;
    for (;;) {
      const page = db.recentGames(7, {}, before);
      seen.push(...page.map((g) => g.id));
      if (page.length < 7) break;
      const last = page[page.length - 1]!;
      before = { id: last.id, finished_at: last.finished_at };
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen.slice(0, 3)).toEqual(['g24', 'g23', 'g22']);
    expect(seen.indexOf('g11')).toBeLessThan(seen.indexOf('g10'));
  });
});
