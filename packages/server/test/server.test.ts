import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { legalMoves, rankOf, resolve as resolvePattern, type Pattern, type PatternType } from '@ddz/engine';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let base: string;
let wsBase: string;

beforeAll(async () => {
  ({ app } = await buildApp({ dbPath: ':memory:', inviteCode: 'secret', rateLimit: 1000, botServiceKey: 'svc-key' }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
});
afterAll(async () => app.close());

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

interface Ev { type: string; seq: number; game_id: string; data: Record<string, any> }

/** Collects events from a socket and lets tests wait for a matching one. */
class Listener {
  events: Ev[] = [];
  ws: WebSocket;
  private waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Ev;
      this.events.push(e);
      this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true));
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  wait(pred: (e: Ev) => boolean, ms = 5000): Promise<Ev> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for event')), ms);
      this.waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  }
  close() {
    this.ws.close();
  }
}

let n = 0;
async function makeBot() {
  const name = `bot${++n}_${Date.now() % 100000}`;
  const r = await api('POST', '/api/v1/bots', undefined, { name, invite_code: 'secret' });
  expect(r.status).toBe(201);
  return r.body as { bot_id: string; token: string; name: string };
}

async function setupTable(config?: Record<string, unknown>) {
  const bots = [await makeBot(), await makeBot(), await makeBot()];
  const room = (await api('POST', '/api/v1/rooms', bots[0]!.token, { name: 't', config })).body;
  const listeners = [];
  for (const [i, b] of bots.entries()) {
    const l = new Listener(`${wsBase}/ws?token=${b.token}`);
    await l.open();
    listeners.push(l);
    expect((await api('POST', `/api/v1/rooms/${room.id}/join`, b.token, { seat: i })).status).toBe(200);
  }
  const spec = new Listener(`${wsBase}/ws/spectate?room=${room.id}`);
  await spec.open();
  return { bots, room, listeners, spec };
}

describe('dissolving a room', () => {
  it('only the creator can dissolve, even mid-game; the game is dropped', async () => {
    const { bots, room, listeners, spec } = await setupTable({ auto_restart: false });
    expect(room.owner_id).toBe(bots[0]!.bot_id);
    for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});
    const started = await spec.wait((e) => e.type === 'game.started');
    expect((await api('DELETE', `/api/v1/rooms/${room.id}`, bots[1]!.token)).body.error.code).toBe('NOT_OWNER');
    expect((await api('DELETE', `/api/v1/rooms/${room.id}`)).status).toBe(401);
    expect((await api('DELETE', `/api/v1/rooms/${room.id}`, bots[0]!.token)).status).toBe(200);
    const ev = await listeners[2]!.wait((e) => e.type === 'room.dissolved');
    expect(ev.data).toEqual({ room_id: room.id, by: bots[0]!.bot_id });
    await spec.wait((e) => e.type === 'room.dissolved');
    expect((await api('GET', `/api/v1/rooms/${room.id}`)).status).toBe(404);
    expect((await api('GET', `/api/v1/games/${started.game_id}/legal-moves`, bots[0]!.token)).status).toBe(404);
    // Everyone is free to sit elsewhere, and the dropped game is not in the history.
    expect((await api('GET', '/api/v1/me', bots[1]!.token)).body.room_id).toBeNull();
    const other = (await api('POST', '/api/v1/rooms', bots[1]!.token, {})).body;
    expect((await api('POST', `/api/v1/rooms/${other.id}/join`, bots[1]!.token, {})).status).toBe(200);
    expect((await api('GET', `/api/v1/games?room_id=${room.id}`)).body.games).toEqual([]);
    [...listeners, spec].forEach((l) => l.close());
  });
});

describe('accounts and errors', () => {
  it('registration and auth', async () => {
    expect((await api('POST', '/api/v1/bots', undefined, { name: 'x1', invite_code: 'nope' })).body.error.code).toBe('BAD_INVITE');
    expect((await api('POST', '/api/v1/bots', undefined, { name: 'bad name!', invite_code: 'secret' })).status).toBe(400);
    const b = await makeBot();
    expect((await api('POST', '/api/v1/bots', undefined, { name: b.name, invite_code: 'secret' })).status).toBe(409);
    expect((await api('GET', '/api/v1/me')).status).toBe(401);
    expect((await api('GET', '/api/v1/me', 'ddz_wrong')).status).toBe(401);
    expect((await api('GET', '/api/v1/me', b.token)).body).toMatchObject({ bot_id: b.bot_id, room_id: null });
    const g = await api('POST', '/api/v1/guests', undefined, { name: `guest_${Date.now() % 100000}` });
    expect(g.status).toBe(201);
    expect(g.body.kind).toBe('human');
  });
  it('404s and bad JSON', async () => {
    const b = await makeBot();
    expect((await api('GET', '/api/v1/rooms/r_nope')).status).toBe(404);
    expect((await api('POST', '/api/v1/rooms/r_nope/join', b.token, {})).status).toBe(404);
    expect((await api('GET', '/api/v1/games/g_nope')).status).toBe(404);
    expect((await api('GET', '/api/v1/nothing')).status).toBe(404);
    const res = await fetch(`${base}/api/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }, body: '{bad' });
    expect(res.status).toBe(400);
    const empty = await fetch(`${base}/api/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' } });
    expect(empty.status).toBe(201);
  });
  it('room seating conflicts', async () => {
    const { bots, room, listeners, spec } = await setupTable({ auto_restart: false });
    const extra = await makeBot();
    expect((await api('POST', `/api/v1/rooms/${room.id}/join`, extra.token, {})).body.error.code).toBe('ROOM_FULL');
    const other = (await api('POST', '/api/v1/rooms', extra.token, {})).body;
    expect((await api('POST', `/api/v1/rooms/${other.id}/join`, bots[0]!.token, {})).body.error.code).toBe('ALREADY_IN_ROOM');
    expect((await api('POST', `/api/v1/rooms/${other.id}/join`, extra.token, { seat: 1 })).status).toBe(200);
    const extra2 = await makeBot();
    expect((await api('POST', `/api/v1/rooms/${other.id}/join`, extra2.token, { seat: 1 })).body.error.code).toBe('SEAT_TAKEN');
    expect((await api('POST', `/api/v1/rooms/${other.id}/ready`, extra2.token, {})).body.error.code).toBe('NOT_IN_ROOM');
    [...listeners, spec].forEach((l) => l.close());
  });
});

describe('full game over HTTP + WebSocket', () => {
  it('plays to the end with validation, privacy and replay', async () => {
    const { bots, room, listeners, spec } = await setupTable({ auto_restart: false });
    for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});

    const started = await Promise.all(listeners.map((l) => l.wait((e) => e.type === 'game.started')));
    started.forEach((e) => expect(e.data.hand).toHaveLength(17));
    const specStart = await spec.wait((e) => e.type === 'game.started');
    expect(specStart.data.hand).toBeUndefined();
    const gid = started[0]!.game_id;

    // State / privacy
    const st = await api('GET', `/api/v1/games/${gid}/state`, bots[0]!.token);
    expect(st.body.hand).toEqual(started[0]!.data.hand);
    const outsider = await makeBot();
    expect((await api('GET', `/api/v1/games/${gid}/state`, outsider.token)).status).toBe(403);
    expect((await api('GET', `/api/v1/games/${gid}`)).body.hand).toBeUndefined();

    // Bidding: wrong player, wrong phase, then first bidder bids 3
    const fb = st.body.first_bidder as number;
    const notFirst = bots[(fb + 1) % 3]!;
    expect((await api('POST', `/api/v1/games/${gid}/bid`, notFirst.token, { score: 1 })).body.error.code).toBe('NOT_YOUR_TURN');
    expect((await api('POST', `/api/v1/games/${gid}/play`, bots[fb]!.token, { cards: [] })).body.error.code).toBe('WRONG_PHASE');
    expect((await api('POST', `/api/v1/games/${gid}/bid`, bots[fb]!.token, { score: 7 })).status).toBe(400);
    expect((await api('POST', `/api/v1/games/${gid}/bid`, bots[fb]!.token, { score: 3, seq: st.body.turn_seq - 1 })).body.error.code).toBe('STALE_SEQ');
    expect((await api('POST', `/api/v1/games/${gid}/bid`, bots[fb]!.token, { score: 3, seq: st.body.turn_seq })).status).toBe(200);
    const decided = await spec.wait((e) => e.type === 'landlord.decided');
    expect(decided.data.landlord).toBe(fb);
    expect(decided.data.bottom).toHaveLength(3);

    // Landlord: must play, invalid pattern, not in hand
    const ll = bots[fb]!;
    const llState = (await api('GET', `/api/v1/games/${gid}/state`, ll.token)).body;
    expect(llState.hand).toHaveLength(20);
    expect((await api('POST', `/api/v1/games/${gid}/play`, ll.token, { cards: [] })).body.error.code).toBe('MUST_PLAY');
    expect((await api('POST', `/api/v1/games/${gid}/play`, ll.token, { cards: ['ZZ'] })).body.error.code).toBe('UNKNOWN_CARD');
    const otherHand = (await api('GET', `/api/v1/games/${gid}/state`, notFirst.token)).body.hand;
    expect((await api('POST', `/api/v1/games/${gid}/play`, ll.token, { cards: [otherHand[0]] })).status).toBe(422);
    expect((await api('POST', `/api/v1/games/${gid}/play`, ll.token, { cards: 'nope' })).status).toBe(400);

    // Play out: each seat plays its lowest legal move (or passes), via HTTP or WS alternately.
    let steps = 0;
    let checkedCannotBeat = false;
    while (true) {
      const s = (await api('GET', `/api/v1/games/${gid}`)).body;
      if (s.phase === 'finished') break;
      const bot = bots[s.turn]!;
      const me = (await api('GET', `/api/v1/games/${gid}/state`, bot.token)).body;
      const toBeat: Pattern | null = me.to_beat ? resolvePattern(me.to_beat.cards, null, me.to_beat.pattern.type as PatternType).ok
        ? (resolvePattern(me.to_beat.cards, null, me.to_beat.pattern.type as PatternType) as { pattern: Pattern }).pattern : null : null;
      const moves = legalMoves(me.hand, toBeat);
      const server = (await api('GET', `/api/v1/games/${gid}/legal-moves`, bot.token)).body;
      expect(server.moves.length).toBe(moves.length);
      if (toBeat && !checkedCannotBeat) {
        const weak = me.hand.find((c: string) => !moves.some((m) => m.cards.length === 1 && rankOf(m.cards[0]!) === rankOf(c)));
        if (weak && toBeat.type === 'single') {
          expect((await api('POST', `/api/v1/games/${gid}/play`, bot.token, { cards: [weak] })).body.error.code).toBe('CANNOT_BEAT');
          checkedCannotBeat = true;
        }
      }
      const cards = moves.length ? moves.sort((a, b) => a.pattern.main - b.pattern.main)[0]!.cards : [];
      if (steps % 2 === 0) {
        const r = await api('POST', `/api/v1/games/${gid}/play`, bot.token, { cards, seq: me.seq });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      } else {
        const l = listeners[s.turn]!;
        const reqId = `r${steps}`;
        l.ws.send(JSON.stringify({ op: 'play', req_id: reqId, game_id: gid, cards, seq: me.seq }));
        const reply = await l.wait((e: any) => e.type === 'reply' && e.req_id === reqId);
        expect((reply as any).status, JSON.stringify(reply)).toBe(200);
      }
      if (++steps > 200) throw new Error('too many steps');
    }

    const fin = await spec.wait((e) => e.type === 'game.finished');
    const scores = fin.data.result.scores as number[];
    expect(scores.reduce((a, b) => a + b, 0)).toBe(0);
    expect(fin.data.seed).toMatch(/^[0-9a-f]{32}$/);

    // Spectator seq is contiguous
    const seqs = spec.events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);

    // Replay + finished-game behaviour
    const rep = (await api('GET', `/api/v1/games/${gid}/replay`)).body;
    expect(rep.initial_hands).toHaveLength(3);
    expect(rep.events.some((e: Ev) => e.type === 'game.finished')).toBe(true);
    expect(rep.events.every((e: Ev) => e.type !== 'game.started' || e.data.hand === undefined)).toBe(true);
    expect((await api('POST', `/api/v1/games/${gid}/play`, ll.token, { cards: [] })).body.error.code).toBe('WRONG_PHASE');
    const list = (await api('GET', `/api/v1/games?bot_id=${ll.bot_id}`)).body;
    expect(list.games[0].game_id).toBe(gid);
    expect(list.next).toBeNull();
    const page = (await api('GET', `/api/v1/games?bot_id=${ll.bot_id}&limit=1`)).body;
    expect(page.next).toBe(gid);
    expect((await api('GET', `/api/v1/games?bot_id=${ll.bot_id}&before=${gid}`)).body).toEqual({ games: [], next: null });
    expect((await api('GET', '/api/v1/games?before=g_nope')).status).toBe(400);
    const lb = (await api('GET', '/api/v1/leaderboard')).body.bots;
    expect(lb.find((b: any) => b.bot_id === ll.bot_id).games).toBe(1);

    // Reconnect with since: backlog is replayed
    const re = new Listener(`${wsBase}/ws?token=${ll.token}&since=${seqs[0]! - 1}`);
    await re.wait((e) => e.type === 'game.finished');
    expect(re.events.find((e) => e.type === 'game.started')?.data.hand).toHaveLength(17);
    [...listeners, spec, re].forEach((l) => l.close());
  });
});

describe('timeouts and trustee', () => {
  it('auto-plays on timeout and enters trustee after 3 timeouts', async () => {
    const { bots, room, listeners, spec } = await setupTable({ bid_timeout_ms: 1000, play_timeout_ms: 1000, auto_restart: false });
    for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});
    const started = await spec.wait((e) => e.type === 'game.started');
    const st = (await api('GET', `/api/v1/games/${started.game_id}/state`, bots[0]!.token)).body;
    // First bidder bids 3 so the game doesn't redeal; everyone then times out.
    await api('POST', `/api/v1/games/${started.game_id}/bid`, bots[st.first_bidder]!.token, { score: 3 });
    const auto = await spec.wait((e) => e.type === 'played' && e.data.auto === true, 4000);
    expect(auto.data.cards).toHaveLength(1);
    await spec.wait((e) => e.type === 'room.updated' && e.data.room.seats.some((s: any) => s?.trustee), 15000);
    [...listeners, spec].forEach((l) => l.close());
  }, 30000);
});

describe('leaving mid-game', () => {
  it('frees the seat when the game ends, and /me no longer reports the room', async () => {
    const { bots, room, listeners, spec } = await setupTable({ auto_restart: false });
    for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});
    await spec.wait((e) => e.type === 'game.started');
    for (const b of bots) expect((await api('POST', `/api/v1/rooms/${room.id}/leave`, b.token, {})).status).toBe(200);
    expect((await api('GET', '/api/v1/me', bots[0]!.token)).body.room_id).toBe(room.id); // still playing for them
    await spec.wait((e) => e.type === 'game.finished', 60000);
    const me = (await api('GET', '/api/v1/me', bots[0]!.token)).body;
    expect(me).toMatchObject({ room_id: null, seat: null });
    expect((await api('POST', `/api/v1/rooms/${room.id}/join`, bots[0]!.token, {})).status).toBe(200);
    [...listeners, spec].forEach((l) => l.close());
  }, 90000);
});

describe('auto restart with disconnected bots', () => {
  it('stops after a game when a seat has no WebSocket and resumes on reconnect', async () => {
    const { bots, room, listeners, spec } = await setupTable();
    listeners[1]!.close();
    listeners[2]!.close();
    for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});
    const started = await spec.wait((e) => e.type === 'game.started');
    const gid = started.game_id;
    const st = (await api('GET', `/api/v1/games/${gid}/state`, bots[0]!.token)).body;
    await api('POST', `/api/v1/games/${gid}/bid`, bots[st.first_bidder]!.token, { score: 3 });
    for (let steps = 0; ; steps++) {
      const s = (await api('GET', `/api/v1/games/${gid}`)).body;
      if (s.phase === 'finished') break;
      const bot = bots[s.turn]!;
      const moves = (await api('GET', `/api/v1/games/${gid}/legal-moves`, bot.token)).body.moves;
      const r = await api('POST', `/api/v1/games/${gid}/play`, bot.token, { cards: moves[0]?.cards ?? [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (steps > 200) throw new Error('too many steps');
    }
    const fin = await spec.wait((e) => e.type === 'game.finished');
    const seatsAfter = (await api('GET', `/api/v1/rooms/${room.id}`)).body.room.seats;
    expect(seatsAfter.map((s: any) => s.ready)).toEqual([true, false, false]);

    // No new game while two seats are away.
    await new Promise((r) => setTimeout(r, 3500));
    expect(spec.events.some((e) => e.type === 'game.started' && e.seq > fin.seq)).toBe(false);

    // Reconnecting re-readies the seat; the game starts once both are back.
    const back1 = new Listener(`${wsBase}/ws?token=${bots[1]!.token}`);
    await back1.open();
    await spec.wait((e) => e.type === 'room.updated' && e.data.room.seats[1].ready === true);
    expect(spec.events.some((e) => e.type === 'game.started' && e.seq > fin.seq)).toBe(false);
    const back2 = new Listener(`${wsBase}/ws?token=${bots[2]!.token}`);
    await back2.open();
    await spec.wait((e) => e.type === 'game.started' && e.seq > fin.seq);
    [listeners[0]!, spec, back1, back2].forEach((l) => l.close());
  }, 30000);
});

/** Seats `n` fresh bots in a new room of `game` and readies them; returns the started game id. */
async function startTable(game: string, n: number, config?: Record<string, unknown>) {
  const bots = [];
  for (let i = 0; i < n; i++) bots.push(await makeBot());
  const created = await api('POST', '/api/v1/rooms', bots[0]!.token, { game, config });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const room = created.body;
  const listeners = [];
  for (const [i, b] of bots.entries()) {
    const l = new Listener(`${wsBase}/ws?token=${b.token}`);
    await l.open();
    listeners.push(l);
    expect((await api('POST', `/api/v1/rooms/${room.id}/join`, b.token, { seat: i })).status).toBe(200);
  }
  const spec = new Listener(`${wsBase}/ws/spectate?room=${room.id}`);
  await spec.open();
  for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});
  const started = await spec.wait((e) => e.type === 'game.started');
  return { bots, room, listeners, spec, gid: started.game_id };
}

describe('game types', () => {
  it('rejects unknown game types and keeps quick-join within a type', async () => {
    const b = await makeBot();
    expect((await api('POST', '/api/v1/rooms', b.token, { game: 'chess' })).status).toBe(400);
    const r4 = (await api('POST', '/api/v1/rooms', b.token, { game: 'ddz4' })).body;
    expect(r4.game).toBe('ddz4');
    expect(r4.seats).toHaveLength(4);
    const q = (await api('POST', '/api/v1/rooms/quick-join', b.token, {})).body;
    expect(q.room.game).toBe('ddz');
    expect(q.room.id).not.toBe(r4.id);
    await api('POST', `/api/v1/rooms/${q.room.id}/leave`, b.token, {});
    const q4 = (await api('POST', '/api/v1/rooms/quick-join', b.token, { game: 'ddz4' })).body;
    expect(q4.room.game).toBe('ddz4');
    await api('POST', `/api/v1/rooms/${q4.room.id}/leave`, b.token, {});
  });

  it('plays a 4-player Dou Dizhu game to the end', async () => {
    const { bots, listeners, spec, gid } = await startTable('ddz4', 4, { auto_restart: false });
    const started = await Promise.all(listeners.map((l) => l.wait((e) => e.type === 'game.started')));
    started.forEach((e) => expect(e.data.hand).toHaveLength(25));
    expect((spec.events.find((e) => e.type === 'game.started')!).data.hand).toBeUndefined();
    const st = (await api('GET', `/api/v1/games/${gid}/state`, bots[0]!.token)).body;
    expect(st.game).toBe('ddz4');
    expect(st.cards_left).toEqual([25, 25, 25, 25]);
    expect((await api('POST', `/api/v1/games/${gid}/bid`, bots[st.first_bidder]!.token, { score: 3 })).status).toBe(200);
    const decided = await spec.wait((e) => e.type === 'landlord.decided');
    expect(decided.data.bottom).toHaveLength(8);
    for (let steps = 0; ; steps++) {
      const s = (await api('GET', `/api/v1/games/${gid}`)).body;
      if (s.phase === 'finished') break;
      const bot = bots[s.turn]!;
      const moves = (await api('GET', `/api/v1/games/${gid}/legal-moves`, bot.token)).body.moves;
      const r = await api('POST', `/api/v1/games/${gid}/play`, bot.token, { cards: moves[0]?.cards ?? [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (steps > 400) throw new Error('too many steps');
    }
    const fin = await spec.wait((e) => e.type === 'game.finished');
    const scores = fin.data.result.scores as number[];
    expect(scores).toHaveLength(4);
    expect(scores.reduce((a, b) => a + b, 0)).toBe(0);
    const lb = (await api('GET', '/api/v1/leaderboard?game=ddz4')).body;
    expect(lb.game).toBe('ddz4');
    expect(lb.bots.find((b: any) => b.bot_id === bots[0]!.bot_id).games).toBe(1);
    const lb3 = (await api('GET', '/api/v1/leaderboard')).body.bots;
    expect(lb3.find((b: any) => b.bot_id === bots[0]!.bot_id)).toBeUndefined();
    const games = (await api('GET', `/api/v1/games?game=ddz4&bot_id=${bots[0]!.bot_id}`)).body.games;
    expect(games[0].game).toBe('ddz4');
    expect(games[0].players).toHaveLength(4);
    const inRoom = (await api('GET', `/api/v1/games?room_id=${games[0].room_id}`)).body.games;
    expect(inRoom.map((g: any) => g.game_id)).toEqual([gid]);
    expect((await api('GET', '/api/v1/games?room_id=r_nope')).body.games).toEqual([]);
    const rep = (await api('GET', `/api/v1/games/${gid}/replay`)).body;
    expect(rep.initial_hands).toHaveLength(4);
    [...listeners, spec].forEach((l) => l.close());
  }, 30000);
});

describe('smart-bot invites', () => {
  it('queues invites for seated players up to the free bots the service reports', async () => {
    const poll = async (q: string, key = 'svc-key') =>
      (await fetch(`${base}/api/v1/bot-service/poll?${q}`, { headers: { 'x-service-key': key } }));
    const owner = await makeBot();
    const room = (await api('POST', '/api/v1/rooms', owner.token, { game: 'guandan' })).body;
    // Not seated yet; then seated but the service has never polled.
    expect((await api('POST', `/api/v1/rooms/${room.id}/smart-bots`, owner.token, {})).status).toBe(403);
    await api('POST', `/api/v1/rooms/${room.id}/join`, owner.token, { seat: 0 });
    expect((await api('POST', `/api/v1/rooms/${room.id}/smart-bots`, owner.token, {})).body.error.code).toBe('BOT_SERVICE_DOWN');
    expect((await poll('free_guandan=2', 'wrong')).status).toBe(401);
    expect((await (await poll('free_guandan=2&free_ddz=4')).json()).invites).toEqual([]);
    expect((await api('GET', '/api/v1/smart-bots')).body).toEqual({ available: true, free: { ddz: 4, ddz4: 0, guandan: 2, gongzhu: 0 } });
    // 3 empty seats but only 2 free bots: 2 invited, then nothing left.
    const r = await api('POST', `/api/v1/rooms/${room.id}/smart-bots`, owner.token, {});
    expect(r.status).toBe(202);
    expect(r.body.invited).toBe(2);
    expect((await api('POST', `/api/v1/rooms/${room.id}/smart-bots`, owner.token, { count: 1 })).body.error.code).toBe('NO_FREE_BOT');
    const got = (await (await poll('free_guandan=2')).json()).invites;
    expect(got).toEqual([{ id: expect.any(Number), room_id: room.id, game: 'guandan', count: 2 }]);
    // Handed-out invites stay deducted until the service reports again.
    expect((await api('GET', '/api/v1/smart-bots')).body.free.guandan).toBe(0);
    // Hold'em has no smart bots.
    const h = (await api('POST', '/api/v1/rooms', owner.token, { game: 'holdem' })).body;
    await api('POST', `/api/v1/rooms/${room.id}/leave`, owner.token, {});
    await api('POST', `/api/v1/rooms/${h.id}/join`, owner.token, {});
    expect((await api('POST', `/api/v1/rooms/${h.id}/smart-bots`, owner.token, {})).status).toBe(400);
    await api('POST', `/api/v1/rooms/${h.id}/leave`, owner.token, {});
  });
});

describe('Guandan', () => {
  /** Drive one hand through the API: returns first, then lead the first legal move or pass. */
  async function playHand(bots: { token: string }[], gid: string) {
    for (let steps = 0; ; steps++) {
      const s = (await api('GET', `/api/v1/games/${gid}`)).body;
      if (s.phase === 'finished') return s;
      const bot = bots[s.turn]!;
      const legal = (await api('GET', `/api/v1/games/${gid}/legal-moves`, bot.token)).body;
      const r =
        s.phase === 'return'
          ? await api('POST', `/api/v1/games/${gid}/return`, bot.token, { card: legal.return_cards[0] })
          : await api('POST', `/api/v1/games/${gid}/play`, bot.token, { cards: s.can_pass ? [] : legal.moves[0].cards });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (steps > 600) throw new Error('too many steps');
    }
  }

  it('plays hands with levels, tribute and returns', async () => {
    const { bots, listeners, spec, gid } = await startTable('guandan', 4);
    const started = await Promise.all(listeners.map((l) => l.wait((e) => e.type === 'game.started')));
    started.forEach((e) => expect(e.data.hand).toHaveLength(27));
    const s0 = spec.events.find((e) => e.type === 'game.started')!.data;
    expect(s0.hand).toBeUndefined();
    expect(s0).toMatchObject({ game: 'guandan', hand_no: 1, level: '2', level_team: 0, team_levels: ['2', '2'] });
    expect((await api('POST', `/api/v1/games/${gid}/bid`, bots[0]!.token, { score: 1 })).status).toBe(400);
    const v = (await api('GET', `/api/v1/games/${gid}`)).body;
    expect(v.phase).toBe('playing');
    expect(v.tribute).toBeNull();
    // Leading with a pass is rejected; a bad hint is a 422.
    const leader = bots[v.turn]!;
    expect((await api('POST', `/api/v1/games/${gid}/play`, leader.token, { cards: [] })).status).toBe(422);
    const fin1 = await playHand(bots, gid);
    expect(fin1.result.order).toHaveLength(4);
    expect(fin1.result.scores.reduce((a: number, b: number) => a + b, 0)).toBe(0);
    const outs = spec.events.filter((e) => e.type === 'player.out' && e.game_id === gid);
    expect(outs.length).toBeGreaterThanOrEqual(2);
    expect(outs[0]!.data).toEqual({ seat: fin1.result.order[0], place: 1 });

    // Second hand: the winning team's level, and a tribute (or anti-tribute) right after game.started.
    const started2 = await spec.wait((e) => e.type === 'game.started' && e.game_id !== gid, 10000);
    const gid2 = started2.game_id;
    expect(started2.data).toMatchObject({ hand_no: 2, level_team: fin1.result.winner_team, team_levels: fin1.result.team_levels_after });
    const trib = await spec.wait((e) => e.type === 'tribute' && e.game_id === gid2);
    const v2 = (await api('GET', `/api/v1/games/${gid2}`)).body;
    if (trib.data.anti) expect(v2.phase).toBe('playing');
    else {
      expect(trib.data.tributes.length).toBeGreaterThan(0);
      expect(v2.phase).toBe('return');
      const receiver = bots[v2.turn]!;
      const st = (await api('GET', `/api/v1/games/${gid2}/state`, receiver.token)).body;
      expect(st.hand).toHaveLength(28);
      expect(st.legal.phase).toBe('return');
      expect((await api('POST', `/api/v1/games/${gid2}/return`, receiver.token, { card: 'RJ' })).status).toBe(422);
    }
    const fin2 = await playHand(bots, gid2);
    expect(fin2.result.scores.reduce((a: number, b: number) => a + b, 0)).toBe(0);
    if (!trib.data.anti) expect(spec.events.some((e) => e.type === 'returned' && e.game_id === gid2)).toBe(true);
    const lb = (await api('GET', '/api/v1/leaderboard?game=guandan')).body;
    expect(lb.bots.find((b: any) => b.bot_id === bots[0]!.bot_id).games).toBe(2);
    const rep = (await api('GET', `/api/v1/games/${gid2}/replay`)).body;
    expect(rep.initial_hands).toHaveLength(4);
    [...listeners, spec].forEach((l) => l.close());
  }, 60000);
});

describe('Gongzhu', () => {
  /** Drive one hand through the API: expose nothing, then play the first legal card. */
  async function playHand(bots: { token: string }[], gid: string) {
    for (let steps = 0; ; steps++) {
      const s = (await api('GET', `/api/v1/games/${gid}`)).body;
      if (s.phase === 'finished') return s;
      const bot = bots[s.turn]!;
      const legal = (await api('GET', `/api/v1/games/${gid}/legal-moves`, bot.token)).body;
      const r =
        s.phase === 'expose'
          ? await api('POST', `/api/v1/games/${gid}/expose`, bot.token, { cards: [] })
          : await api('POST', `/api/v1/games/${gid}/play`, bot.token, { card: legal.cards[0] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (steps > 200) throw new Error('too many steps');
    }
  }

  it('plays hands with exposing, tricks and carried totals', async () => {
    const { bots, listeners, spec, gid } = await startTable('gongzhu', 4);
    const started = await Promise.all(listeners.map((l) => l.wait((e) => e.type === 'game.started')));
    started.forEach((e) => expect(e.data.hand).toHaveLength(13));
    const s0 = spec.events.find((e) => e.type === 'game.started')!.data;
    expect(s0.hand).toBeUndefined();
    expect(s0).toMatchObject({ game: 'gongzhu', hand_no: 1, totals: [0, 0, 0, 0] });
    // The holder of 2C exposes first and leads.
    const holder = started.findIndex((e) => e.data.hand.includes('2C'));
    expect(s0.first_leader).toBe(holder);
    const v = (await api('GET', `/api/v1/games/${gid}`)).body;
    expect(v).toMatchObject({ phase: 'expose', turn: holder, exposed: [[], [], [], []] });
    const lead = bots[holder]!;
    expect((await api('POST', `/api/v1/games/${gid}/play`, lead.token, { card: '2C' })).status).toBe(409);
    const st = (await api('GET', `/api/v1/games/${gid}/state`, lead.token)).body;
    expect(st.legal.phase).toBe('expose');
    const bad = await api('POST', `/api/v1/games/${gid}/expose`, lead.token, { cards: ['2C'] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('BAD_EXPOSE');
    const ex = await api('POST', `/api/v1/games/${gid}/expose`, lead.token, { cards: st.legal.exposable });
    expect(ex.status).toBe(200);
    const shown = await spec.wait((e) => e.type === 'exposed');
    expect(shown.data).toEqual({ seat: holder, cards: st.legal.exposable, auto: false });

    const fin1 = await playHand(bots, gid);
    expect(fin1.result.taken.flat()).toHaveLength(16);
    expect(fin1.result.scores.reduce((a: number, b: number) => a + b, 0)).toBe(0);
    expect(fin1.result.exposed[holder]).toEqual(st.legal.exposable);
    const won = spec.events.filter((e) => e.type === 'trick.won' && e.game_id === gid);
    expect(won.length).toBe(fin1.tricks.length);
    expect(won.flatMap((e) => e.data.cards).sort()).toEqual(fin1.result.taken.flat().sort());

    // Second hand: totals carried, the pig taker leads.
    const started2 = await spec.wait((e) => e.type === 'game.started' && e.game_id !== gid, 10000);
    expect(started2.data).toMatchObject({ hand_no: 2, totals: fin1.result.totals_after, first_leader: fin1.result.pig });
    const fin2 = await playHand(bots, started2.game_id);
    expect(fin2.result.totals_before).toEqual(fin1.result.totals_after);
    const lb = (await api('GET', '/api/v1/leaderboard?game=gongzhu')).body;
    expect(lb.bots.find((b: any) => b.bot_id === bots[0]!.bot_id).games).toBe(2);
    const rep = (await api('GET', `/api/v1/games/${started2.game_id}/replay`)).body;
    expect(rep.initial_hands).toHaveLength(4);
    [...listeners, spec].forEach((l) => l.close());
  }, 60000);
});

describe("Texas Hold'em", () => {
  it('plays hands with private hole cards, a moving button and validation', async () => {
    const bots = [await makeBot(), await makeBot(), await makeBot()];
    const room = (await api('POST', '/api/v1/rooms', bots[0]!.token, { game: 'holdem', config: { seats: 6 } })).body;
    expect(room.seats).toHaveLength(6);
    const seats = [0, 2, 4];
    const listeners = [];
    for (const [i, b] of bots.entries()) {
      const l = new Listener(`${wsBase}/ws?token=${b.token}`);
      await l.open();
      listeners.push(l);
      expect((await api('POST', `/api/v1/rooms/${room.id}/join`, b.token, { seat: seats[i] })).status).toBe(200);
    }
    const spec = new Listener(`${wsBase}/ws/spectate?room=${room.id}`);
    await spec.open();
    for (const b of bots) await api('POST', `/api/v1/rooms/${room.id}/ready`, b.token, {});
    const started = await spec.wait((e) => e.type === 'game.started');
    expect(started.data.hole).toBeUndefined();
    expect(started.data.stacks).toHaveLength(6);
    expect(started.data.stacks[1]).toBeNull();
    const mine = await listeners[0]!.wait((e) => e.type === 'game.started');
    expect(mine.data.hole).toHaveLength(2);
    const gid = started.game_id;
    const button1 = started.data.button;

    const botAt = (seat: number) => bots[seats.indexOf(seat)]!;
    const s0 = (await api('GET', `/api/v1/games/${gid}`)).body;
    expect(s0.game).toBe('holdem');
    expect(s0.phase).toBe('preflop');
    const actor = botAt(s0.turn);
    // Wrong verb, bad action, too-small raise, then a legal min raise.
    expect((await api('POST', `/api/v1/games/${gid}/play`, actor.token, { cards: [] })).status).toBe(400);
    expect((await api('POST', `/api/v1/games/${gid}/action`, actor.token, { action: 'dance' })).body.error.code).toBe('BAD_ACTION');
    expect((await api('POST', `/api/v1/games/${gid}/action`, actor.token, { action: 'check' })).body.error.code).toBe('CANNOT_CHECK');
    const me = (await api('GET', `/api/v1/games/${gid}/state`, actor.token)).body;
    expect(me.hole).toHaveLength(2);
    expect(me.legal.to_call).toBe(2);
    expect((await api('POST', `/api/v1/games/${gid}/action`, actor.token, { action: 'raise', amount: me.legal.min_raise_to - 1 })).body.error.code).toBe('BAD_AMOUNT');
    expect((await api('POST', `/api/v1/games/${gid}/action`, actor.token, { action: 'raise', amount: me.legal.min_raise_to })).status).toBe(200);

    // Everyone else calls / checks down to showdown.
    for (let steps = 0; ; steps++) {
      const s = (await api('GET', `/api/v1/games/${gid}`)).body;
      if (s.phase === 'finished') break;
      const b = botAt(s.turn);
      const st = (await api('GET', `/api/v1/games/${gid}/state`, b.token)).body;
      const r = await api('POST', `/api/v1/games/${gid}/action`, b.token, { action: st.legal.can_check ? 'check' : 'call', seq: st.seq });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      if (steps > 50) throw new Error('too many steps');
    }
    const fin = await spec.wait((e) => e.type === 'game.finished');
    const scores = fin.data.result.scores as (number | null)[];
    expect(scores[1]).toBeNull();
    expect(scores.reduce((a: number, b) => a + (b ?? 0), 0)).toBe(0);
    expect(fin.data.result.showdown).toHaveLength(3);
    expect(spec.events.filter((e) => e.type === 'board').map((e) => e.data.phase)).toEqual(['flop', 'turn', 'river']);
    // `bet` is the seat's street total even for the action that closes the street.
    const preflopActs = spec.events.filter((e) => e.type === 'acted' && e.game_id === gid && e.data.phase === 'preflop');
    expect(preflopActs.at(-1)!.data.bet).toBe(preflopActs[0]!.data.amount);

    // Next hand starts automatically with the button moved clockwise.
    const next = await spec.wait((e) => e.type === 'game.started' && e.game_id !== gid, 8000);
    expect(next.data.button).toBe(seats[(seats.indexOf(button1) + 1) % 3]);
    const rep = (await api('GET', `/api/v1/games/${gid}/replay`)).body;
    expect(rep.holes.filter((h: unknown) => h !== null)).toHaveLength(3);
    expect((await api('GET', `/api/v1/games/${gid}`)).body.holes).toBeUndefined();
    const lb = (await api('GET', '/api/v1/leaderboard?game=holdem')).body.bots;
    expect(lb.find((b: any) => b.bot_id === bots[0]!.bot_id).games).toBe(1);

    // A bot that joins mid-hand sits out and gets no hole cards for it.
    const late = await makeBot();
    const lateWs = new Listener(`${wsBase}/ws?token=${late.token}`);
    await lateWs.open();
    expect((await api('POST', `/api/v1/rooms/${room.id}/join`, late.token, { seat: 5 })).status).toBe(200);
    expect((await api('GET', `/api/v1/games/${next.game_id}/state`, late.token)).status).toBe(403);
    expect(lateWs.events.some((e) => e.type === 'game.started' && e.data.hole)).toBe(false);
    [...listeners, spec, lateWs].forEach((l) => l.close());
  }, 30000);
});
