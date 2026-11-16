// Endless demo table: three bots play in one room named "三机演示" forever, pausing before each
// action so humans can follow along in the web UI. Runs next to the server (deploy/ddz-demo.service).
//
//   DDZ_DEMO_BASE=http://127.0.0.1:8080 DDZ_INVITE_CODE=... node deploy/demo.mjs   (defaults to 127.0.0.1:$PORT)
//
// Tokens are kept in DDZ_DEMO_STATE (default data/demo.json) so the same three bots are reused.
// A supervisor loop recreates the room after a server restart (rooms live in memory).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = (process.env.DDZ_DEMO_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`).replace(/\/$/, '');
const INVITE = process.env.DDZ_INVITE_CODE;
const PAUSE_MS = Number(process.env.DDZ_DEMO_PAUSE_MS ?? 1500);
const STATE = process.env.DDZ_DEMO_STATE ?? 'data/demo.json';
const ROOM_NAME = '三机演示';
const BOTS = [
  { name: '演示-贪心A', style: 'greedy' },
  { name: '演示-贪心B', style: 'greedy' },
  { name: '演示-随机C', style: 'random' },
];
const RANKS = '3456789TJQKA2'.split('').concat(['BJ', 'RJ']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString().slice(0, 19), ...m);

async function api(method, path, token, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(BASE + '/api/v1' + path, {
        method,
        headers: {
          'user-agent': 'ddz-demo/1.0',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < 5) {
        await sleep(200);
        continue;
      }
      return { status: res.status, data };
    } catch (e) {
      if (attempt >= 5) return { status: 0, data: { error: { code: 'NETWORK_ERROR', message: String(e) } } };
      await sleep(1000); // server restarting
    }
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return { bots: {}, room: null };
  }
}
const state = loadState();
const saveState = () => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
};

async function register(spec) {
  if (state.bots[spec.name]) return state.bots[spec.name];
  let name = spec.name;
  for (let i = 0; ; i++) {
    const r = await api('POST', '/bots', null, { name, invite_code: INVITE });
    if (r.status === 201) {
      state.bots[spec.name] = r.data.token;
      saveState();
      log('registered', name);
      return r.data.token;
    }
    if (r.data?.error?.code !== 'NAME_TAKEN' || i > 5) throw new Error(`register ${name}: ${JSON.stringify(r.data)}`);
    name = `${spec.name}${Math.random().toString(36).slice(2, 5)}`;
  }
}

// ---------- strategy ----------

const rankOf = (c) => (c === 'BJ' || c === 'RJ' ? c : c[0]);

function bidFor(style, hand, highBid) {
  let want;
  if (style === 'random') want = Math.floor(Math.random() * 4);
  else {
    const counts = {};
    for (const c of hand) counts[rankOf(c)] = (counts[rankOf(c)] ?? 0) + 1;
    const bombs = Object.values(counts).filter((n) => n === 4).length;
    const s = (counts['2'] ?? 0) + (counts.BJ ? 1.5 : 0) + (counts.RJ ? 2 : 0) + bombs * 2 + (counts.A ?? 0) * 0.5;
    want = s >= 6 ? 3 : s >= 4.5 ? 2 : s >= 3 ? 1 : 0;
  }
  return want > highBid ? want : 0;
}

function chooseMove(style, st, moves) {
  if (!moves.length) return [];
  if (style === 'random') {
    if (st.can_pass && Math.random() < 0.3) return [];
    return moves[Math.floor(Math.random() * moves.length)].cards;
  }
  // Greedy: don't beat a teammate; otherwise play the lowest move, bombs last.
  const teammate = st.to_beat && st.landlord !== null && st.to_beat.seat !== st.landlord && st.seat !== st.landlord;
  if (teammate && st.can_pass) return [];
  const isBomb = (m) => (m.pattern.type === 'bomb' || m.pattern.type === 'rocket' ? 1 : 0);
  moves.sort(
    (a, b) =>
      isBomb(a) - isBomb(b) || RANKS.indexOf(a.pattern.rank) - RANKS.indexOf(b.pattern.rank) || b.cards.length - a.cards.length,
  );
  // Only bomb when someone is close to winning.
  if (isBomb(moves[0]) && st.can_pass && Math.min(...st.cards_left) > 4) return [];
  return moves[0].cards;
}

// ---------- bots ----------

class DemoBot {
  constructor(spec, token) {
    Object.assign(this, spec, { token, seat: null, lastSeq: 0, acting: false });
  }

  connect(delay = 500) {
    const url = `${BASE.replace(/^http/, 'ws')}/ws?token=${this.token}${this.lastSeq ? `&since=${this.lastSeq}` : ''}`;
    const ws = new WebSocket(url);
    ws.onmessage = (m) => this.onEvent(JSON.parse(m.data));
    ws.onopen = () => (delay = 500);
    ws.onclose = () => setTimeout(() => this.connect(Math.min(delay * 2, 10000)), delay);
    ws.onerror = () => {};
  }

  onEvent(ev) {
    if (process.env.DDZ_DEMO_DEBUG) log(this.name, ev.type, ev.seq, JSON.stringify(ev.data ?? {}).slice(0, 80));
    if (ev.type === 'hello') {
      if (ev.data.seq < this.lastSeq) this.lastSeq = 0; // server restarted: seq counter reset
      return;
    }
    if (typeof ev.seq === 'number') {
      if (ev.seq <= this.lastSeq) return;
      this.lastSeq = ev.seq;
    }
    if ((ev.type === 'bid.turn' || ev.type === 'turn') && ev.data.seat === this.seat) this.act(ev);
    if (ev.type === 'game.finished' && this.seat === 0) {
      const r = ev.data.result;
      log(`game ${ev.game_id}: ${r.kind} winner=${r.winner ?? '-'} scores=${r.scores.join(',')}`);
    }
  }

  /** Act on our turn. A turn can arrive while we are still acting (the landlord's first play is pushed
   * before its bid's HTTP response returns), so keep the newest one and handle it afterwards. */
  async act(ev) {
    this.pending = ev;
    if (this.acting) return;
    this.acting = true;
    try {
      while (this.pending) {
        const gid = this.pending.game_id;
        this.pending = null;
        await sleep(PAUSE_MS);
        await this.takeTurn(gid);
      }
    } catch (e) {
      log(this.name, 'act failed:', e.message);
    } finally {
      this.acting = false;
    }
  }

  async takeTurn(gid) {
    const st = (await api('GET', `/games/${gid}/state`, this.token)).data;
    if (!st || st.turn !== this.seat) return;
    if (st.phase === 'bidding') {
      await api('POST', `/games/${gid}/bid`, this.token, { score: bidFor(this.style, st.hand, st.high_bid), seq: st.seq });
      return;
    }
    if (st.phase !== 'playing') return;
    const moves = (await api('GET', `/games/${gid}/legal-moves`, this.token)).data.moves ?? [];
    const r = await api('POST', `/games/${gid}/play`, this.token, { cards: chooseMove(this.style, st, moves), seq: st.seq });
    if (r.status >= 400) log(this.name, 'play rejected', r.status, JSON.stringify(r.data));
  }
}

// ---------- room supervisor ----------

async function ensureRoom(bots) {
  if (state.room) {
    const r = await api('GET', `/rooms/${state.room}`);
    if (r.status === 0) return; // server down; try again later
    const room = r.data?.room;
    if (r.status === 200 && bots.every((b, i) => room.seats[i]?.bot_id === b.id)) {
      bots.forEach((b, i) => (b.seat = i));
      // Watchdog: pick up a turn whose event was missed (e.g. it arrived before seats were known).
      if (room.status === 'playing' && room.game_id) for (const b of bots) b.act({ game_id: room.game_id });
      if (room.status === 'waiting') {
        for (const [i, b] of bots.entries()) if (!room.seats[i].ready) await api('POST', `/rooms/${room.id}/ready`, b.token, { ready: true });
      }
      return;
    }
  }
  const created = await api('POST', '/rooms', bots[0].token, { name: ROOM_NAME });
  if (created.status !== 201) throw new Error(`create room: ${JSON.stringify(created.data)}`);
  const rid = created.data.id;
  for (const [i, b] of bots.entries()) {
    const cur = (await api('GET', '/me', b.token)).data;
    if (cur.room_id && cur.room_id !== rid) await api('POST', `/rooms/${cur.room_id}/leave`, b.token, {});
    const j = await api('POST', `/rooms/${rid}/join`, b.token, { seat: i });
    if (j.status !== 200) throw new Error(`join: ${JSON.stringify(j.data)}`);
    b.seat = i;
  }
  for (const b of bots) await api('POST', `/rooms/${rid}/ready`, b.token, { ready: true });
  state.room = rid;
  saveState();
  log(`room ${rid} ready: ${BASE}/#/room/${rid}`);
}

const bots = [];
for (const spec of BOTS) {
  const bot = new DemoBot(spec, await register(spec));
  const me = await api('GET', '/me', bot.token);
  if (me.status !== 200) throw new Error(`me: ${JSON.stringify(me.data)}`);
  bot.id = me.data.bot_id;
  bots.push(bot);
}
for (const b of bots) b.connect();
await sleep(1000); // let sockets open before seating, so the first events aren't missed
for (;;) {
  try {
    await ensureRoom(bots);
  } catch (e) {
    log('supervisor:', e.message);
  }
  await sleep(20_000);
}
