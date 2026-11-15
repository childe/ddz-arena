// Stress test: N rooms x 3 bots play random legal moves over the public API until each room finishes G games.
// Usage: node packages/server/scripts/stress.ts --base http://localhost:8080 --rooms 20 --games 50 [--invite CODE]
import WebSocket from 'ws';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:8080' },
    rooms: { type: 'string', default: '10' },
    games: { type: 'string', default: '20' },
    invite: { type: 'string' },
  },
});
const base = values.base!;
const wsBase = base.replace(/^http/, 'ws');
const ROOMS = Number(values.rooms);
const GAMES = Number(values.games);

const stats = { games: 0, http: new Map<number, number>(), scoreMismatch: 0, stalls: 0 };

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  stats.http.set(res.status, (stats.http.get(res.status) ?? 0) + 1);
  return { status: res.status, body: await res.json() as any };
}

async function bot(roomId: string | null, tag: string): Promise<{ token: string; roomId: string }> {
  const name = `st_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  const reg = await api('POST', '/api/v1/bots', undefined, { name, invite_code: values.invite });
  if (reg.status !== 201) throw new Error(JSON.stringify(reg.body));
  const token = reg.body.token as string;
  const ws = new WebSocket(`${wsBase}/ws?token=${token}`);
  await new Promise((r) => ws.once('open', r));
  const joined = roomId
    ? await api('POST', `/api/v1/rooms/${roomId}/join`, token, {})
    : await api('POST', '/api/v1/rooms', token, { name: `stress-${tag}`, config: { auto_restart: true } }).then(async (r) =>
      api('POST', `/api/v1/rooms/${r.body.id}/join`, token, {}));
  const rid = joined.body.room.id as string;
  const seat = joined.body.seat as number;
  ws.on('message', async (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.data?.seat !== seat) return;
    if (e.type === 'bid.turn') {
      const want = Math.floor(Math.random() * 4);
      await api('POST', `/api/v1/games/${e.game_id}/bid`, token, { score: want > e.data.high_bid ? want : 0, seq: e.seq });
    } else if (e.type === 'turn') {
      const lm = await api('GET', `/api/v1/games/${e.game_id}/legal-moves`, token);
      const moves = lm.body.moves ?? [];
      const pick = Math.floor(Math.random() * (moves.length + (e.data.can_pass ? 1 : 0)));
      const cards = pick < moves.length ? moves[pick].cards : [];
      const r = await api('POST', `/api/v1/games/${e.game_id}/play`, token, { cards, seq: e.seq });
      if (r.status !== 200) console.error('play failed', r.status, r.body);
    }
  });
  await api('POST', `/api/v1/rooms/${rid}/ready`, token, {});
  return { token, roomId: rid };
}

async function runRoom(i: number) {
  const first = await bot(null, `${i}a`);
  await bot(first.roomId, `${i}b`);
  await bot(first.roomId, `${i}c`);
  const spec = new WebSocket(`${wsBase}/ws/spectate?room=${first.roomId}`);
  let done = 0;
  let lastEvent = Date.now();
  await new Promise<void>((resolve) => {
    const watchdog = setInterval(() => {
      if (Date.now() - lastEvent > 30_000) {
        stats.stalls++;
        console.error(`room ${first.roomId} stalled`);
        clearInterval(watchdog);
        resolve();
      }
    }, 5000);
    spec.on('message', (raw) => {
      lastEvent = Date.now();
      const e = JSON.parse(raw.toString());
      if (e.type !== 'game.finished') return;
      const s = e.data.result.scores as number[];
      if (s[0]! + s[1]! + s[2]! !== 0) stats.scoreMismatch++;
      stats.games++;
      if (++done >= GAMES) {
        clearInterval(watchdog);
        resolve();
      }
    });
  });
  spec.close();
}

const t0 = Date.now();
await Promise.all(Array.from({ length: ROOMS }, (_, i) => runRoom(i)));
const secs = (Date.now() - t0) / 1000;
console.log(JSON.stringify({
  rooms: ROOMS, games: stats.games, seconds: secs, games_per_sec: +(stats.games / secs).toFixed(2),
  stalls: stats.stalls, score_mismatch: stats.scoreMismatch, http: Object.fromEntries(stats.http),
}));
process.exit(stats.stalls || stats.scoreMismatch ? 1 : 0);
