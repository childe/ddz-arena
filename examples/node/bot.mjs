// Minimal Dou Dizhu bot with zero dependencies (Node >= 22: global fetch + WebSocket).
// It shows the whole protocol without any SDK, so it can be ported to any language.
//
//   node examples/node/bot.mjs --base https://ddz.ohmycat.me --name my-bot --invite CODE [--room r_xxx] [--verbose]
//
// Strategy is deliberately trivial: it asks the server for legal moves (GET /legal-moves) and plays the
// smallest one. Real bots should implement the rules themselves (see docs/api.md §3), because ranked
// rooms may disable the legal-moves endpoint.
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:8080' },
    name: { type: 'string', default: `node-bot-${Math.random().toString(36).slice(2, 6)}` },
    invite: { type: 'string' },
    token: { type: 'string' },
    room: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});
const BASE = args.base.replace(/\/$/, '');
const log = (...m) => args.verbose && console.log(new Date().toISOString().slice(11, 23), ...m);

// ---------- HTTP ----------
let token = args.token;
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + '/api/v1' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    log('HTTP', method, path, body ? JSON.stringify(body) : '', '->', res.status, JSON.stringify(data).slice(0, 200));
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 100)); // rate limited: back off and retry
      continue;
    }
    return { status: res.status, data };
  }
}

// ---------- state ----------
let seat = null; // my seat 0..2 in the current room
let roomId = null;
let lastSeq = 0; // newest event seq seen; used for reconnect (since=) and stale-request protection

async function onBidTurn(ev) {
  // Bid 3 with a strong hand would be smarter; here: bid 1 if nobody has bid, else pass.
  const score = ev.data.high_bid === 0 ? 1 : 0;
  await api('POST', `/games/${ev.game_id}/bid`, { score, seq: ev.seq });
}

async function onTurn(ev) {
  const { data: lm } = await api('GET', `/games/${ev.game_id}/legal-moves`);
  const moves = lm.moves ?? [];
  // Pick the lowest-ranked move, keeping bombs and the rocket for last; pass if nothing beats the table.
  const order = '3456789TJQKA2'.split('').concat(['BJ', 'RJ']);
  const isBomb = (m) => (m.pattern.type === 'bomb' || m.pattern.type === 'rocket' ? 1 : 0);
  moves.sort((a, b) => isBomb(a) - isBomb(b) || order.indexOf(a.pattern.rank) - order.indexOf(b.pattern.rank) || b.cards.length - a.cards.length);
  const cards = moves.length ? moves[0].cards : [];
  const r = await api('POST', `/games/${ev.game_id}/play`, { cards, seq: ev.seq });
  if (r.status === 422 && ev.data.can_pass) await api('POST', `/games/${ev.game_id}/play`, { cards: [], seq: ev.seq });
}

function onEvent(ev) {
  if (typeof ev.seq === 'number') {
    if (ev.seq <= lastSeq) return; // duplicate after reconnect
    lastSeq = ev.seq;
  }
  log('WS ', ev.type, JSON.stringify(ev.data ?? {}).slice(0, 200));
  switch (ev.type) {
    case 'game.started':
      console.log(`game ${ev.game_id} started, my hand: ${ev.data.hand.join(' ')}`);
      break;
    case 'bid.turn':
      if (ev.data.seat === seat) onBidTurn(ev);
      break;
    case 'turn':
      if (ev.data.seat === seat) onTurn(ev);
      break;
    case 'game.finished':
      console.log(`game ${ev.game_id} finished: ${ev.data.result.winner ?? 'no bid'} wins, my score ${ev.data.result.scores[seat]}`);
      break;
    case 'resync':
      // Server could not replay missed events; a real bot would GET /games/{gid}/state here.
      break;
  }
}

// ---------- WebSocket with reconnect ----------
function connect(delay = 500) {
  const url = `${BASE.replace(/^http/, 'ws')}/ws?token=${token}${lastSeq ? `&since=${lastSeq}` : ''}`;
  const ws = new WebSocket(url);
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = () => {
    console.log(`socket closed, reconnecting in ${delay}ms`);
    setTimeout(() => connect(Math.min(delay * 2, 15000)), delay);
  };
  return new Promise((resolve) => (ws.onopen = () => resolve(ws)));
}

// ---------- main ----------
if (!token) {
  const r = await api('POST', '/bots', { name: args.name, invite_code: args.invite });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
  token = r.data.token;
  console.log(`registered ${r.data.name}; save this token to reuse the bot: ${token}`);
}
await connect(); // connect first so no event is missed after joining
const joined = args.room ? await api('POST', `/rooms/${args.room}/join`, {}) : await api('POST', '/rooms/quick-join');
if (joined.status !== 200) throw new Error(`join failed: ${JSON.stringify(joined.data)}`);
roomId = joined.data.room.id;
seat = joined.data.seat;
console.log(`seated in room ${roomId} seat ${seat}; spectate at ${BASE}/#/room/${roomId}`);
await api('POST', `/rooms/${roomId}/ready`, { ready: true });
