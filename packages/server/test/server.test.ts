import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { legalMoves, rankOf, resolve as resolvePattern, type Pattern, type PatternType } from '@ddz/engine';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let base: string;
let wsBase: string;

beforeAll(async () => {
  ({ app } = await buildApp({ dbPath: ':memory:', inviteCode: 'secret', rateLimit: 1000 }));
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
    const games = (await api('GET', `/api/v1/games?bot_id=${ll.bot_id}`)).body.games;
    expect(games[0].game_id).toBe(gid);
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
