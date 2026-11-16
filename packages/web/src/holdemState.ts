// Hold'em table state: built from a snapshot (GET room / game / replay) and advanced by events (docs/api.md §9).
// Per-seat arrays are indexed by room seat; null = seat not in this hand.
import type {
  Card,
  HoldemActionRecord,
  HoldemLegal,
  HoldemPhase,
  HoldemPublicGame,
  HoldemReplay,
  HoldemResult,
  Player,
  WsEvent,
} from './api.ts';

export interface SeatAction {
  key: string;
  action: HoldemActionRecord['action'];
  amount: number;
  all_in: boolean;
  auto?: boolean;
  /** Highest bet on the street before this action (0 = a raise is an opening bet). */
  bet_before: number;
}

export type HoldemLogEntry =
  | { key: string; kind: 'start'; button: number }
  | { key: string; kind: 'act'; rec: HoldemActionRecord; auto?: boolean; bet_before: number }
  | { key: string; kind: 'board'; phase: HoldemPhase; cards: Card[] }
  | { key: string; kind: 'finish'; result: HoldemResult };

export interface HoldemView {
  game_id: string;
  phase: HoldemPhase;
  players: Player[];
  /** Number of seats in the room (length of every per-seat array). */
  n: number;
  button: number | null;
  small_blind_seat: number | null;
  big_blind_seat: number | null;
  small_blind: number;
  big_blind: number;
  board: Card[];
  pot: number;
  current_bet: number;
  stacks: (number | null)[];
  bets: (number | null)[];
  committed: (number | null)[];
  folded: (boolean | null)[];
  all_in: (boolean | null)[];
  /** Stack at the start of the hand (stack + committed), to show net chips. */
  start_stacks: (number | null)[];
  /** Known hole cards: own (player), all (replay) or shown at showdown. */
  holes: (Card[] | null)[];
  turn: number | null;
  remaining_ms: number | null;
  clock_at: number;
  turn_seq: number;
  /** Options for the seat to act (from the `turn` event / PlayerGame.legal). */
  legal: HoldemLegal | null;
  /** Last action of each seat in the current street. */
  last_actions: (SeatAction | null)[];
  history: HoldemActionRecord[];
  result: HoldemResult | null;
  log: HoldemLogEntry[];
}

const fill = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

function arr<T>(v: unknown, n: number): (T | null)[] {
  const a = Array.isArray(v) ? (v as (T | null)[]) : [];
  return Array.from({ length: n }, (_, i) => (a[i] === undefined ? null : a[i]!));
}

/** Seat count: the room's, else the longest per-seat array we were given. */
function seatCount(hint: number | undefined, ...arrays: unknown[]): number {
  if (hint && hint > 0) return hint;
  let n = 0;
  for (const a of arrays) if (Array.isArray(a)) n = Math.max(n, a.length);
  return Math.max(2, n);
}

/** Blind posts implied by game.started (they have no `acted` event). */
function blindRecords(sb: number | null, bb: number | null, bets: (number | null)[], stacks: (number | null)[]): HoldemActionRecord[] {
  const out: HoldemActionRecord[] = [];
  if (sb !== null && sb !== undefined) out.push({ seat: sb, phase: 'preflop', action: 'small_blind', amount: bets[sb] ?? 0, all_in: stacks[sb] === 0 });
  if (bb !== null && bb !== undefined) out.push({ seat: bb, phase: 'preflop', action: 'big_blind', amount: bets[bb] ?? 0, all_in: stacks[bb] === 0 });
  return out;
}

function lastActionsFor(history: HoldemActionRecord[], phase: HoldemPhase, n: number): (SeatAction | null)[] {
  const out = fill<SeatAction | null>(n, null);
  const street: Record<number, number> = {};
  let high = 0;
  history.forEach((h, i) => {
    if (h.phase !== phase) return;
    out[h.seat] = { key: `h${i}`, action: h.action, amount: h.amount, all_in: h.all_in, bet_before: high };
    const now = streetBetAfter(street[h.seat] ?? 0, h);
    street[h.seat] = now;
    high = Math.max(high, now);
  });
  return out;
}

/** A seat's street bet after action `h`, given its bet before. */
function streetBetAfter(prev: number, h: HoldemActionRecord): number {
  if (h.action === 'raise') return h.amount;
  if (h.action === 'fold' || h.action === 'check') return prev;
  return prev + h.amount;
}

/** Builds a log from a history list, tracking the street's highest bet so raises read as 下注 / 加注 correctly. */
function logFromHistory(history: HoldemActionRecord[], board: Card[], button: number | null, gid: string): HoldemLogEntry[] {
  const log: HoldemLogEntry[] = [{ key: `start-${gid}`, kind: 'start', button: button ?? -1 }];
  let phase: HoldemPhase = 'preflop';
  let high = 0;
  let street: Record<number, number> = {};
  const boardFor: Record<string, Card[]> = { flop: board.slice(0, 3), turn: board.slice(3, 4), river: board.slice(4, 5) };
  history.forEach((h, i) => {
    if (h.phase !== phase) {
      phase = h.phase;
      high = 0;
      street = {};
      if (boardFor[phase]?.length) log.push({ key: `b-${phase}`, kind: 'board', phase, cards: boardFor[phase]! });
    }
    log.push({ key: `h${i}`, kind: 'act', rec: h, bet_before: high });
    const now = streetBetAfter(street[h.seat] ?? 0, h);
    street[h.seat] = now;
    high = Math.max(high, now);
  });
  // Streets dealt after the last action (all-in run-out).
  for (const p of ['flop', 'turn', 'river'] as const) {
    const order = ['preflop', 'flop', 'turn', 'river'];
    if (order.indexOf(p) > order.indexOf(phase) && boardFor[p]?.length) log.push({ key: `b-${p}`, kind: 'board', phase: p, cards: boardFor[p]! });
  }
  return log;
}

function showdownHoles(holes: (Card[] | null)[], result: HoldemResult | null): (Card[] | null)[] {
  if (!result?.showdown) return holes;
  const out = [...holes];
  for (const e of result.showdown) if (e.hole?.length) out[e.seat] = e.hole;
  return out;
}

export function holdemFromSnapshot(
  g: HoldemPublicGame,
  now: number,
  roomSeats?: number,
  own?: { seat: number; hole: Card[]; legal?: HoldemLegal },
): HoldemView {
  const n = seatCount(roomSeats, g.stacks, g.bets, g.committed);
  const stacks = arr<number>(g.stacks, n);
  const committed = arr<number>(g.committed, n);
  const history = [...(g.history ?? [])];
  const phase = g.phase ?? 'preflop';
  const v: HoldemView = {
    game_id: g.game_id,
    phase,
    players: (g.players ?? []).map((p, i) => ({ ...p, seat: typeof p.seat === 'number' ? p.seat : i })),
    n,
    button: g.button ?? null,
    small_blind_seat: g.small_blind_seat ?? null,
    big_blind_seat: g.big_blind_seat ?? null,
    small_blind: g.small_blind ?? 1,
    big_blind: g.big_blind ?? 2,
    board: [...(g.board ?? [])],
    pot: g.pot ?? 0,
    current_bet: g.current_bet ?? 0,
    stacks,
    bets: arr<number>(g.bets, n),
    committed,
    folded: arr<boolean>(g.folded, n),
    all_in: arr<boolean>(g.all_in, n),
    start_stacks: stacks.map((s, i) => (s === null ? null : s + (committed[i] ?? 0))),
    holes: fill<Card[] | null>(n, null),
    turn: phase === 'finished' ? null : (g.turn ?? null),
    remaining_ms: phase === 'finished' ? null : (g.remaining_ms ?? null),
    clock_at: now,
    turn_seq: g.turn_seq ?? 0,
    legal: null,
    last_actions: phase === 'finished' ? fill(n, null) : lastActionsFor(history, phase, n),
    history,
    result: g.result ?? null,
    log: [],
  };
  if (v.result) v.start_stacks = startFromResult(v);
  v.log = logFromHistory(history, v.board, v.button, v.game_id);
  if (v.result) v.log.push({ key: 'fin', kind: 'finish', result: v.result });
  if (own && own.seat >= 0 && own.seat < n && Array.isArray(own.hole)) v.holes[own.seat] = [...own.hole];
  if (own?.legal && v.turn === own.seat) v.legal = own.legal;
  v.holes = showdownHoles(v.holes, v.result);
  return v;
}

/** After the hand, stacks already include payouts, so start = stack - net. */
function startFromResult(v: HoldemView): (number | null)[] {
  const r = v.result!;
  return v.stacks.map((s, i) => (s === null ? v.start_stacks[i] ?? null : s - (r.scores[i] ?? 0)));
}

function seatOfViewer(players: Player[], viewer: string | null): number {
  if (!viewer) return -1;
  return players.find((p) => p.bot_id === viewer)?.seat ?? -1;
}

/** Applies one event to the hold'em view (null view: only game.started creates one). */
export function applyHoldemEvent(
  g0: HoldemView | null,
  ev: WsEvent,
  seq: number,
  now: number,
  ctx: { viewer: string | null; roomSeats?: number },
): HoldemView | null {
  const d = ev.data ?? {};
  const key = `e${seq}`;
  if (ev.type === 'game.started') {
    const n = seatCount(ctx.roomSeats, d.stacks, d.bets);
    const stacks = arr<number>(d.stacks, n);
    const bets = arr<number>(d.bets, n);
    const players: Player[] = (d.players ?? []).map((p: Player, i: number) => ({ ...p, seat: typeof p.seat === 'number' ? p.seat : i }));
    const inHand = (i: number) => stacks[i] !== null;
    const sb = d.small_blind_seat ?? null;
    const bb = d.big_blind_seat ?? null;
    const history = blindRecords(sb, bb, bets, stacks);
    const v: HoldemView = {
      game_id: ev.game_id ?? '',
      phase: 'preflop',
      players,
      n,
      button: d.button ?? null,
      small_blind_seat: sb,
      big_blind_seat: bb,
      small_blind: d.small_blind ?? 1,
      big_blind: d.big_blind ?? 2,
      board: [],
      pot: d.pot ?? 0,
      current_bet: Math.max(0, ...bets.map((b) => b ?? 0)),
      stacks,
      bets,
      committed: [...bets],
      folded: stacks.map((_, i) => (inHand(i) ? false : null)),
      all_in: stacks.map((s, i) => (inHand(i) ? s === 0 : null)),
      start_stacks: stacks.map((s, i) => (s === null ? null : s + (bets[i] ?? 0))),
      holes: fill<Card[] | null>(n, null),
      turn: null,
      remaining_ms: null,
      clock_at: now,
      turn_seq: 0,
      legal: null,
      last_actions: lastActionsFor(history, 'preflop', n),
      history,
      result: null,
      log: [{ key: `start-${key}`, kind: 'start', button: d.button ?? -1 }, ...history.map((h, i) => ({ key: `${key}-bl${i}`, kind: 'act' as const, rec: h, bet_before: 0 }))],
    };
    const me = seatOfViewer(players, ctx.viewer);
    if (Array.isArray(d.hole) && me >= 0) v.holes[me] = [...d.hole];
    return v;
  }
  if (!g0) return null;
  if (ev.game_id && g0.game_id && ev.game_id !== g0.game_id) return g0;
  const g: HoldemView = { ...g0 };

  switch (ev.type) {
    case 'turn':
      g.turn = d.seat;
      g.remaining_ms = d.remaining_ms ?? null;
      g.clock_at = now;
      g.turn_seq = seq;
      if (d.phase && d.phase !== 'finished') g.phase = d.phase;
      if (typeof d.pot === 'number') g.pot = d.pot;
      if (typeof d.current_bet === 'number') g.current_bet = d.current_bet;
      g.legal = {
        phase: d.phase,
        to_call: d.to_call ?? 0,
        can_check: !!d.can_check,
        min_raise_to: d.min_raise_to ?? null,
        max_raise_to: d.max_raise_to ?? null,
        current_bet: d.current_bet ?? g.current_bet,
        pot: d.pot ?? g.pot,
      };
      return g;
    case 'acted': {
      const s: number = d.seat;
      const rec: HoldemActionRecord = { seat: s, phase: d.phase ?? g.phase, action: d.action, amount: d.amount ?? 0, all_in: !!d.all_in };
      const prevBet = g.bets[s] ?? 0;
      // Derived from the action: the server reads `bet` after a finished street is reset, so it is 0 for the closing action.
      const bet = streetBetAfter(prevBet, rec);
      const betBefore = g.current_bet;
      g.bets = [...g.bets];
      g.bets[s] = bet;
      g.committed = [...g.committed];
      g.committed[s] = (g.committed[s] ?? 0) + Math.max(0, bet - prevBet);
      if (typeof d.stack === 'number') {
        g.stacks = [...g.stacks];
        g.stacks[s] = d.stack;
      }
      if (d.action === 'fold') {
        g.folded = [...g.folded];
        g.folded[s] = true;
      }
      if (d.all_in) {
        g.all_in = [...g.all_in];
        g.all_in[s] = true;
      }
      if (typeof d.pot === 'number') g.pot = d.pot;
      g.current_bet = Math.max(g.current_bet, bet);
      g.last_actions = [...g.last_actions];
      g.last_actions[s] = { key, action: rec.action, amount: rec.amount, all_in: rec.all_in, auto: d.auto, bet_before: betBefore };
      g.history = [...g.history, rec];
      g.log = [...g.log, { key, kind: 'act', rec, auto: d.auto, bet_before: betBefore }];
      if (g.turn === s) {
        g.remaining_ms = null;
        g.legal = null;
      }
      return g;
    }
    case 'board': {
      g.phase = d.phase ?? g.phase;
      g.board = Array.isArray(d.board) ? [...d.board] : [...g.board, ...(d.cards ?? [])];
      g.bets = g.bets.map((b) => (b === null ? null : 0));
      g.current_bet = 0;
      g.last_actions = fill(g.n, null);
      g.turn = null;
      g.remaining_ms = null;
      g.legal = null;
      g.log = [...g.log, { key, kind: 'board', phase: g.phase, cards: d.cards ?? [] }];
      return g;
    }
    case 'game.finished': {
      const r: HoldemResult | null = d.result ?? null;
      g.phase = 'finished';
      g.turn = null;
      g.remaining_ms = null;
      g.legal = null;
      g.result = r;
      if (r) {
        g.stacks = g.start_stacks.map((s, i) => (s === null ? g.stacks[i] ?? null : s + (r.scores[i] ?? 0)));
        g.bets = g.bets.map((b) => (b === null ? null : 0));
        g.pot = r.pot ?? g.pot;
        g.holes = showdownHoles(g.holes, r);
        g.log = [...g.log, { key, kind: 'finish', result: r }];
      }
      return g;
    }
    default:
      return g0;
  }
}

const REPLAY_SKIP = new Set(['hello', 'room.updated', 'resync', 'pong', 'reply']);

/** One state per acted / board / finished event; `turn` events update the current step in place. */
export function buildHoldemReplayStates(rep: HoldemReplay): HoldemView[] {
  const n = seatCount(undefined, rep.stacks, rep.holes);
  const holes = arr<Card[]>(rep.holes, n).map((h) => (h ? [...h] : null));
  const states: HoldemView[] = [];
  let cur: HoldemView | null = null;
  let seq = 0;
  for (const ev of rep.events ?? []) {
    if (REPLAY_SKIP.has(ev.type)) continue;
    seq = typeof ev.seq === 'number' ? ev.seq : seq + 1;
    const next = applyHoldemEvent(cur, ev, seq, ev.ts ?? 0, { viewer: null, roomSeats: n });
    if (!next || next === cur) continue;
    if (ev.type === 'game.started') {
      next.holes = holes.map((h) => (h ? [...h] : null));
      next.remaining_ms = null;
    }
    const replaceStep = ev.type === 'turn' && states.length > 0;
    cur = { ...next, remaining_ms: null };
    if (replaceStep) states[states.length - 1] = cur;
    else states.push(cur);
  }
  if (states.length === 0) {
    // No events recorded: show the final snapshot with every hole card.
    const v = holdemFromSnapshot(rep, 0, n);
    v.holes = holes.map((h, i) => h ?? v.holes[i] ?? null);
    states.push(v);
  }
  return states;
}

// ---- display helpers ----

export const HOLDEM_PHASE_LABELS: Record<HoldemPhase, string> = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  finished: '已结束',
};

export const HOLDEM_RANK_LABELS: Record<string, string> = {
  high_card: '高牌',
  pair: '一对',
  two_pair: '两对',
  three_of_a_kind: '三条',
  straight: '顺子',
  flush: '同花',
  full_house: '葫芦',
  four_of_a_kind: '四条',
  straight_flush: '同花顺',
};

export function holdemRankLabel(rank: string, best?: Card[]): string {
  if (rank === 'straight_flush' && best?.some((c) => c[0] === 'A') && best.some((c) => c[0] === 'K')) return '皇家同花顺';
  return HOLDEM_RANK_LABELS[rank] ?? rank;
}

/** Chinese text for an action. `betBefore` = highest bet on the street before it (raise with 0 = 下注). */
export function holdemActionText(a: { action: string; amount: number; all_in: boolean }, betBefore?: number): string {
  let t: string;
  switch (a.action) {
    case 'fold':
      t = '弃牌';
      break;
    case 'check':
      t = '过牌';
      break;
    case 'call':
      t = `跟注 ${a.amount}`;
      break;
    case 'raise':
      t = betBefore === 0 ? `下注 ${a.amount}` : `加注到 ${a.amount}`;
      break;
    case 'small_blind':
      t = `小盲 ${a.amount}`;
      break;
    case 'big_blind':
      t = `大盲 ${a.amount}`;
      break;
    default:
      t = a.action;
  }
  return a.all_in && a.action !== 'fold' && a.action !== 'check' ? `${t}（全下）` : t;
}

export function holdemSeatName(v: HoldemView | null, roomSeatNames: (string | undefined)[] | undefined, seat: number): string {
  return roomSeatNames?.[seat] ?? v?.players.find((p) => p.seat === seat)?.name ?? `座位 ${seat}`;
}
