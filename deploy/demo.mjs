// Endless demo tables: one room per game type ("三机演示" for 3-player Dou Dizhu, "四人斗地主演示",
// "德州扑克演示", "掼蛋演示") where bots play forever, pausing before each action so humans can follow along in
// the web UI. Runs next to the server (deploy/ddz-demo.service).
//
//   DDZ_DEMO_BASE=http://127.0.0.1:8080 DDZ_INVITE_CODE=... node deploy/demo.mjs   (defaults to 127.0.0.1:$PORT)
//
// Tokens and room ids are kept in DDZ_DEMO_STATE (default data/demo.json) so the same bots are reused.
// A supervisor loop recreates rooms after a server restart (rooms live in memory).
//
// A `{ smart: true }` entry is a seat for one smart bot from the smart-bot service (ddz-bots), invited
// through POST /rooms/{rid}/smart-bots. It stays because the demo bots count as other players; if the
// service is down the seat stays empty and the supervisor retries the invite.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cardValue, evaluateHoldem, isBombLike, isWildcard, strength } from '@ddz/engine';

const BASE = (process.env.DDZ_DEMO_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`).replace(/\/$/, '');
const INVITE = process.env.DDZ_INVITE_CODE;
const PAUSE_MS = Number(process.env.DDZ_DEMO_PAUSE_MS ?? 1500);
const STATE = process.env.DDZ_DEMO_STATE ?? 'data/demo.json';
const TABLES = [
  {
    key: 'ddz', game: 'ddz', room: '三机演示',
    bots: [{ name: '演示-贪心A', style: 'greedy' }, { smart: true }, { name: '演示-随机C', style: 'random' }],
  },
  {
    key: 'ddz4', game: 'ddz4', room: '四人斗地主演示',
    bots: [
      { name: '四人-贪心A', style: 'greedy' }, { smart: true },
      { name: '四人-贪心C', style: 'greedy' }, { name: '四人-随机D', style: 'random' },
    ],
  },
  {
    key: 'holdem', game: 'holdem', room: '德州扑克演示', config: { seats: 6 },
    bots: [
      { name: '德州-紧凶A', style: 'tight' }, { name: '德州-紧凶B', style: 'tight' },
      { name: '德州-松浪C', style: 'loose' }, { name: '德州-随机D', style: 'random' },
    ],
  },
  {
    key: 'guandan', game: 'guandan', room: '掼蛋演示',
    bots: [
      { name: '掼蛋-贪心A', style: 'greedy' }, { smart: true },
      { name: '掼蛋-贪心C', style: 'greedy' }, { name: '掼蛋-随机D', style: 'random' },
    ],
  },
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
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    s.rooms ??= s.room ? { ddz: s.room } : {}; // older single-table state file
    delete s.room;
    return s;
  } catch {
    return { bots: {}, rooms: {} };
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

// ---------- Dou Dizhu strategy ----------

const rankOf = (c) => (c === 'BJ' || c === 'RJ' ? c : c[0]);

function bidFor(style, hand, highBid) {
  let want;
  if (style === 'random') want = Math.floor(Math.random() * 4);
  else {
    const counts = {};
    for (const c of hand) counts[rankOf(c)] = (counts[rankOf(c)] ?? 0) + 1;
    const bombs = Object.entries(counts).filter(([r, n]) => n >= 4 && r !== 'BJ' && r !== 'RJ').length;
    // Normalize for 4-player hands (25 cards, two decks) so the bid rate stays similar.
    const scale = hand.length > 20 ? 0.6 : 1;
    const s = scale * ((counts['2'] ?? 0) + (counts.BJ ?? 0) * 1.5 + (counts.RJ ?? 0) * 2 + (counts.A ?? 0) * 0.5) + bombs * 2;
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

// ---------- Guandan strategy ----------

function guandanMove(style, st, moves) {
  if (!moves.length) return [];
  if (style === 'random') {
    if (st.can_pass && Math.random() < 0.3) return [];
    return moves[Math.floor(Math.random() * moves.length)].cards;
  }
  // Greedy: never beat the partner; play the weakest move, keeping bombs and the wildcard for later.
  if (st.can_pass && st.to_beat?.seat === (st.seat + 2) % 4) return [];
  const wild = (m) => m.cards.filter((c) => isWildcard(c, st.level)).length;
  const bomb = (m) => (isBombLike(m.pattern) ? 1 : 0);
  moves.sort((a, b) => bomb(a) - bomb(b) || wild(a) - wild(b) || strength(a.pattern, st.level) - strength(b.pattern, st.level) || b.cards.length - a.cards.length);
  // Only bomb when an opponent is close to going out.
  const oppMin = Math.min(...[1, 3].map((d) => st.cards_left[(st.seat + d) % 4]).filter((n) => n > 0));
  if (bomb(moves[0]) && st.can_pass && oppMin > 6) return [];
  return moves[0].cards;
}

function guandanReturn(st, cards) {
  return [...cards].sort((a, b) => cardValue(a, st.level) - cardValue(b, st.level))[0];
}

// ---------- Hold'em strategy ----------

const HOLDEM_RANKS = '23456789TJQKA';

/** Rough preflop strength 0..1 from the two hole cards. */
function preflopStrength([a, b]) {
  const ra = HOLDEM_RANKS.indexOf(a[0]);
  const rb = HOLDEM_RANKS.indexOf(b[0]);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  let s = (hi + lo) / 24;
  if (ra === rb) s = 0.55 + ra / 27;
  if (a[1] === b[1]) s += 0.06;
  if (hi - lo === 1) s += 0.04;
  return Math.min(1, s);
}

const CATEGORY = ['high_card', 'pair', 'two_pair', 'three_of_a_kind', 'straight', 'flush', 'full_house', 'four_of_a_kind', 'straight_flush'];

function holdemAction(style, st) {
  const l = st.legal;
  const passive = () => (l.can_check ? { action: 'check' } : { action: 'fold' });
  const raiseTo = (target) => {
    if (l.min_raise_to === null) return { action: l.to_call > 0 ? 'call' : 'check' };
    return { action: 'raise', amount: Math.max(l.min_raise_to, Math.min(l.max_raise_to, Math.round(target))) };
  };
  if (style === 'random') {
    const r = Math.random();
    if (r < 0.15 && l.min_raise_to !== null) return raiseTo(l.min_raise_to + Math.random() * (l.max_raise_to - l.min_raise_to) * 0.3);
    if (r < 0.75) return l.to_call > 0 ? { action: 'call' } : { action: 'check' };
    return passive();
  }
  const loose = style === 'loose';
  let strength;
  if (st.board.length === 0) strength = preflopStrength(st.hole);
  else strength = (CATEGORY.indexOf(evaluateHoldem([...st.hole, ...st.board]).rank) + 1) / 5; // pair ≈ 0.4, two pair ≈ 0.6
  const potOdds = l.to_call / Math.max(1, st.pot + l.to_call);
  if (strength >= (loose ? 0.6 : 0.7)) return raiseTo((l.current_bet || st.big_blind) + st.pot * (loose ? 1 : 0.75));
  if (strength >= (loose ? 0.35 : 0.45) && potOdds <= (loose ? 0.4 : 0.3)) return l.to_call > 0 ? { action: 'call' } : { action: 'check' };
  if (loose && l.to_call === 0 && Math.random() < 0.2) return raiseTo(st.pot * 0.5 + st.big_blind);
  return passive();
}

// ---------- bots ----------

class DemoBot {
  constructor(spec, token, table) {
    Object.assign(this, spec, { token, table, seat: null, lastSeq: 0, acting: false });
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
    if (ev.type === 'game.finished' && this === this.table.bots[0]) {
      const r = ev.data.result;
      const scores = Array.isArray(r.scores) ? r.scores.map((x) => x ?? '-').join(',') : '';
      const what = r.kind ?? (r.winner_team !== undefined ? `team${r.winner_team}+${r.upgrade}@${r.level}` : (r.showdown?.[0]?.rank ?? 'fold'));
      log(`${this.table.key} ${ev.game_id}: ${what} scores=${scores}`);
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
    let r;
    if (st.game === 'guandan') {
      const legal = (await api('GET', `/games/${gid}/legal-moves`, this.token)).data;
      if (st.phase === 'return') {
        r = await api('POST', `/games/${gid}/return`, this.token, { card: guandanReturn(st, legal.return_cards ?? []), seq: st.seq });
      } else if (st.phase === 'playing') {
        r = await api('POST', `/games/${gid}/play`, this.token, { cards: guandanMove(this.style, st, legal.moves ?? []), seq: st.seq });
      }
    } else if (st.game === 'holdem') {
      if (!st.legal) return;
      r = await api('POST', `/games/${gid}/action`, this.token, { ...holdemAction(this.style, st), seq: st.seq });
    } else if (st.phase === 'bidding') {
      r = await api('POST', `/games/${gid}/bid`, this.token, { score: bidFor(this.style, st.hand, st.high_bid), seq: st.seq });
    } else if (st.phase === 'playing') {
      const moves = (await api('GET', `/games/${gid}/legal-moves`, this.token)).data.moves ?? [];
      r = await api('POST', `/games/${gid}/play`, this.token, { cards: chooseMove(this.style, st, moves), seq: st.seq });
    }
    if (r && r.status >= 400) log(this.name, 'rejected', r.status, JSON.stringify(r.data));
  }
}

// ---------- room supervisor ----------

async function ensureRoom(table) {
  const { bots, seats } = table;
  const rid = state.rooms[table.key];
  if (rid) {
    const r = await api('GET', `/rooms/${rid}`);
    if (r.status === 0) return; // server down; try again later
    const room = r.data?.room;
    if (r.status === 200 && room.game === table.game && bots.every((b) => room.seats[b.seat]?.bot_id === b.id)) {
      // Watchdog: pick up a turn whose event was missed (e.g. it arrived before seats were known).
      if (room.status === 'playing' && room.game_id) for (const b of bots) b.act({ game_id: room.game_id });
      if (room.status === 'waiting') {
        for (const b of bots) if (!room.seats[b.seat].ready) await api('POST', `/rooms/${room.id}/ready`, b.token, { ready: true });
        await inviteSmart(table, room);
      }
      return;
    }
  }
  const created = await api('POST', '/rooms', bots[0].token, { name: table.room, game: table.game, config: table.config });
  if (created.status !== 201) throw new Error(`create room: ${JSON.stringify(created.data)}`);
  const room = created.data;
  for (const b of bots) {
    const cur = (await api('GET', '/me', b.token)).data;
    if (cur.room_id && cur.room_id !== room.id) await api('POST', `/rooms/${cur.room_id}/leave`, b.token, {});
    const j = await api('POST', `/rooms/${room.id}/join`, b.token, { seat: b.seat });
    if (j.status !== 200) throw new Error(`join: ${JSON.stringify(j.data)}`);
  }
  for (const b of bots) await api('POST', `/rooms/${room.id}/ready`, b.token, { ready: true });
  state.rooms[table.key] = room.id;
  saveState();
  log(`${table.key} room ${room.id} ready: ${BASE}/#/room/${room.id}`);
  await inviteSmart(table, { id: room.id, seats: seats.map(() => null) });
}

/** Ask the smart-bot service to fill the room's smart seats; they are the only seats left empty. */
async function inviteSmart(table, room) {
  const empty = table.seats.filter((b, i) => b === null && !room.seats[i]).length;
  if (!empty) return;
  const r = await api('POST', `/rooms/${room.id}/smart-bots`, table.bots[0].token, { count: empty });
  if (r.status === 202) log(`${table.key} invited ${r.data.invited} smart bot(s)`);
  else log(`${table.key} smart-bot invite failed:`, r.status, JSON.stringify(r.data));
}

// Bots dropped from TABLES (e.g. replaced by a smart seat) leave their old room, so it doesn't linger.
const current = new Set(TABLES.flatMap((t) => t.bots.filter((s) => !s.smart).map((s) => s.name)));
for (const [name, token] of Object.entries(state.bots)) {
  if (current.has(name)) continue;
  const me = await api('GET', '/me', token);
  if (me.data?.room_id) {
    await api('POST', `/rooms/${me.data.room_id}/leave`, token, {});
    log('retired', name, 'left', me.data.room_id);
  }
}

for (const table of TABLES) {
  const seats = [];
  for (const [i, spec] of table.bots.entries()) {
    if (spec.smart) {
      seats.push(null);
      continue;
    }
    const bot = new DemoBot(spec, await register(spec), table);
    const me = await api('GET', '/me', bot.token);
    if (me.status !== 200) throw new Error(`me: ${JSON.stringify(me.data)}`);
    bot.id = me.data.bot_id;
    bot.seat = i;
    seats.push(bot);
  }
  table.seats = seats;
  table.bots = seats.filter(Boolean);
  for (const b of table.bots) b.connect();
}
await sleep(1000); // let sockets open before seating, so the first events aren't missed
for (;;) {
  for (const table of TABLES) {
    try {
      await ensureRoom(table);
    } catch (e) {
      log(`supervisor ${table.key}:`, e.message);
    }
  }
  await sleep(20_000);
}
