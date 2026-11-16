// Guandan table state (docs/guandan.md section 5): built from a snapshot (GET room / game / replay) and
// advanced by events. Always 4 seats; seats 0/2 are team 0, seats 1/3 team 1.
import { type GdLevel, isLevel, isReturnable, isWildcard, removeCards4, sortByValue } from '@ddz/engine';
import type {
  Card,
  GdPhase,
  GdResult,
  GdTransfer,
  GdTributeInfo,
  GuandanPublicGame,
  GuandanReplay,
  Player,
  PlayRecord,
  WsEvent,
} from './api.ts';
import type { PlayView } from './state.ts';

export type GdLogEntry =
  | { key: string; kind: 'start'; hand_no: number; level: string; level_team: number }
  | { key: string; kind: 'tribute'; anti: boolean; tributes: GdTransfer[] }
  | { key: string; kind: 'return'; t: GdTransfer }
  | { key: string; kind: 'play'; seat: number; cards: Card[]; pattern: PlayRecord['pattern']; auto?: boolean }
  | { key: string; kind: 'out'; seat: number; place: number }
  | { key: string; kind: 'finish'; result: GdResult };

export interface GuandanView {
  game_id: string;
  phase: GdPhase;
  players: Player[];
  n: 4;
  hand_no: number;
  level: GdLevel;
  /** Team whose level is played this hand. */
  level_team: 0 | 1;
  team_levels: [string, string];
  a_attempts: [number, number];
  /** null: first hand of a match (no tribute step). */
  tribute: GdTributeInfo | null;
  returns: GdTransfer[];
  turn: number | null;
  remaining_ms: number | null;
  clock_at: number;
  turn_seq: number;
  to_beat: PlayRecord | null;
  can_pass: boolean;
  cards_left: number[];
  /** Seats that are out, first finisher first (all four once finished). */
  order: number[];
  history: PlayRecord[];
  /** Most recent action per seat in the current trick (cards: [] = 不出). */
  last_plays: (PlayView | null)[];
  /** Known hands (own hand live, all hands in replays), sorted by value for the level. */
  hands: (Card[] | null)[];
  result: GdResult | null;
  log: GdLogEntry[];
}

const N = 4;
const fill = <T,>(v: T): T[] => Array.from({ length: N }, () => v);

export const gdTeamOf = (seat: number): 0 | 1 => (seat % 2) as 0 | 1;
export const gdPartnerOf = (seat: number): number => (seat + 2) % N;
export const asLevel = (v: unknown): GdLevel => (isLevel(v) ? v : '2');

export const PLACE_LABELS = ['头游', '二游', '三游', '末游'];
/** "10" for T, otherwise the rank label as is. */
export const levelLabel = (l: string): string => (l === 'T' ? '10' : l);

/** Cards the receiver may give back: natural 2–10 (no joker, no wildcard); if none, anything but the wildcard. */
export function returnableCards(hand: Card[], level: GdLevel): Set<Card> {
  let ok = hand.filter((c) => isReturnable(c, level));
  if (ok.length === 0) ok = hand.filter((c) => !isWildcard(c, level));
  return new Set(ok);
}

/** The return still owed in the return phase: receiver `from` gives a card back to payer `to`. */
export function pendingReturn(v: GuandanView): { from: number; to: number } | null {
  if (v.phase !== 'return' || !v.tribute || v.tribute.anti) return null;
  const t = v.tribute.tributes[v.returns.length];
  return t ? { from: t.to, to: t.from } : null;
}

const SEQ_TYPES = new Set(['straight', 'pair_chain', 'plane', 'straight_flush']);
const NATURAL = '23456789TJQKA';

/**
 * Card order for showing a play: sequences in natural order (A low when the top is 5 or below, as in
 * A2345 / AA2233 / AAA222) with wildcards last; everything else by value for the level.
 */
export function playOrder(cards: Card[], pattern: PlayRecord['pattern'], level: GdLevel): Card[] {
  if (!pattern || !SEQ_TYPES.has(pattern.type)) return sortByValue(cards, level);
  const aLow = NATURAL.indexOf(pattern.rank) <= NATURAL.indexOf('5');
  const key = (c: Card) => {
    if (isWildcard(c, level)) return 100;
    const r = NATURAL.indexOf(c[0]!);
    return c[0] === 'A' && aLow ? -1 : r;
  };
  return [...cards].sort((a, b) => key(a) - key(b) || a.localeCompare(b));
}

/** Puts a play/pass into the per-seat "current trick" view, clearing it when the seat leads. */
function trackTrick(last: (PlayView | null)[], lastNonPass: number | null, rec: PlayView): (PlayView | null)[] {
  const out = rec.cards.length > 0 && (lastNonPass === null || lastNonPass === rec.seat) ? fill<PlayView | null>(null) : [...last];
  out[rec.seat] = rec;
  return out;
}

function lastNonPassSeat(history: PlayRecord[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.cards.length > 0) return history[i]!.seat;
  return null;
}

/** Moves one card between known hands (tribute / return). */
function moveCard(hands: (Card[] | null)[], t: GdTransfer, level: GdLevel): (Card[] | null)[] {
  const out = [...hands];
  const from = out[t.from];
  if (from) out[t.from] = removeCards4(from, [t.card]);
  const to = out[t.to];
  if (to) out[t.to] = sortByValue([...to, t.card], level);
  return out;
}

function moveCount(left: number[], t: GdTransfer): number[] {
  const out = [...left];
  out[t.from] = Math.max(0, (out[t.from] ?? 0) - 1);
  out[t.to] = (out[t.to] ?? 0) + 1;
  return out;
}

function normPlayers(players: Player[] | undefined): Player[] {
  return (players ?? []).map((p, i) => ({ ...p, seat: typeof p.seat === 'number' ? p.seat : i }));
}

function blank(game_id: string, players: Player[], d: Partial<GuandanPublicGame>, now: number): GuandanView {
  const level = asLevel(d.level);
  const levelTeam = d.level_team === 1 ? 1 : 0;
  const handNo = typeof d.hand_no === 'number' ? d.hand_no : 1;
  return {
    game_id,
    phase: 'playing',
    players,
    n: 4,
    hand_no: handNo,
    level,
    level_team: levelTeam,
    team_levels: Array.isArray(d.team_levels) ? [String(d.team_levels[0]), String(d.team_levels[1])] : [level, level],
    a_attempts: Array.isArray(d.a_attempts) ? [Number(d.a_attempts[0]) || 0, Number(d.a_attempts[1]) || 0] : [0, 0],
    tribute: null,
    returns: [],
    turn: null,
    remaining_ms: null,
    clock_at: now,
    turn_seq: 0,
    to_beat: null,
    can_pass: false,
    cards_left: Array.isArray(d.cards_left) && d.cards_left.length === N ? d.cards_left.map(Number) : fill(27),
    order: [],
    history: [],
    last_plays: fill(null),
    hands: fill(null),
    result: null,
    log: [{ key: `start-${game_id}`, kind: 'start', hand_no: handNo, level, level_team: levelTeam }],
  };
}

/** Builds the view from a GuandanPublicGame / GuandanPlayerGame snapshot. */
export function guandanFromSnapshot(g: GuandanPublicGame, now: number, own?: { seat: number; hand: Card[] }): GuandanView {
  const v = blank(g.game_id, normPlayers(g.players), g, now);
  v.phase = g.phase ?? 'playing';
  v.tribute = g.tribute ?? null;
  v.returns = [...(g.returns ?? [])];
  v.turn = v.phase === 'finished' ? null : (g.turn ?? null);
  v.remaining_ms = v.phase === 'finished' ? null : (g.remaining_ms ?? null);
  v.turn_seq = g.turn_seq ?? 0;
  v.to_beat = g.to_beat ?? null;
  v.can_pass = !!g.can_pass;
  v.order = [...(g.order ?? [])];
  v.history = (g.history ?? []).map((h) => ({ ...h, cards: h.cards.length ? playOrder(h.cards, h.pattern, v.level) : [] }));
  v.result = g.result ?? null;

  const log: GdLogEntry[] = [v.log[0]!];
  if (v.tribute) log.push({ key: 'trib', kind: 'tribute', anti: v.tribute.anti, tributes: v.tribute.tributes });
  v.returns.forEach((t, i) => log.push({ key: `ret${i}`, kind: 'return', t }));
  // A seat with no cards left went out on its last non-pass play.
  const outAt = new Map<number, number>();
  v.order.forEach((s, place) => {
    if (v.cards_left[s] !== 0) return;
    for (let i = v.history.length - 1; i >= 0; i--) {
      if (v.history[i]!.seat === s && v.history[i]!.cards.length) {
        outAt.set(i, place + 1);
        break;
      }
    }
  });
  let lastNon: number | null = null;
  v.history.forEach((h, i) => {
    const rec: PlayView = { ...h, key: `h${i}` };
    v.last_plays = trackTrick(v.last_plays, lastNon, rec);
    if (h.cards.length) lastNon = h.seat;
    log.push({ key: `h${i}`, kind: 'play', seat: h.seat, cards: h.cards, pattern: h.pattern });
    const place = outAt.get(i);
    if (place) log.push({ key: `out${i}`, kind: 'out', seat: h.seat, place });
  });
  if (v.phase === 'playing' && v.turn !== null) {
    if (!v.to_beat) v.last_plays = fill(null);
    else v.last_plays[v.turn] = null;
  }
  if (v.result) log.push({ key: 'fin', kind: 'finish', result: v.result });
  v.log = log;
  if (own && own.seat >= 0 && own.seat < N && Array.isArray(own.hand)) v.hands[own.seat] = sortByValue(own.hand, v.level);
  return v;
}

/** Applies one event to the guandan view (null view: only game.started creates one). */
export function applyGuandanEvent(
  g0: GuandanView | null,
  ev: WsEvent,
  seq: number,
  now: number,
  ctx: { viewer: string | null; roomSeatOf?: (botId: string) => number },
): GuandanView | null {
  const d = ev.data ?? {};
  const key = `e${seq}`;
  if (ev.type === 'game.started') {
    const players = normPlayers(d.players ?? g0?.players);
    const v = blank(ev.game_id ?? '', players, d, now);
    v.log[0] = { ...v.log[0]!, key: `start-${key}` } as GdLogEntry;
    if (Array.isArray(d.hand) && ctx.viewer) {
      const seat = players.find((p) => p.bot_id === ctx.viewer)?.seat ?? ctx.roomSeatOf?.(ctx.viewer) ?? -1;
      if (seat >= 0) v.hands[seat] = sortByValue(d.hand, v.level);
    }
    return v;
  }
  if (!g0) return null;
  if (ev.game_id && g0.game_id && ev.game_id !== g0.game_id) return g0;
  const g: GuandanView = { ...g0 };

  switch (ev.type) {
    case 'tribute': {
      const anti = !!d.anti;
      const tributes: GdTransfer[] = Array.isArray(d.tributes) ? d.tributes : [];
      g.tribute = { anti, tributes };
      for (const t of tributes) {
        g.hands = moveCard(g.hands, t, g.level);
        g.cards_left = moveCount(g.cards_left, t);
      }
      g.log = [...g.log, { key, kind: 'tribute', anti, tributes }];
      return g;
    }
    case 'turn':
      if (d.phase === 'return' || d.phase === 'playing') g.phase = d.phase;
      g.turn = d.seat;
      g.remaining_ms = d.remaining_ms ?? null;
      g.clock_at = now;
      g.to_beat = d.to_beat ?? null;
      g.can_pass = !!d.can_pass;
      g.turn_seq = seq;
      if (g.phase === 'playing') g.last_plays = g.to_beat ? g.last_plays.map((p, i) => (i === d.seat ? null : p)) : fill(null);
      return g;
    case 'returned': {
      const t: GdTransfer = { from: d.from, to: d.to, card: d.card, auto: d.auto };
      g.returns = [...g.returns, t];
      g.hands = moveCard(g.hands, t, g.level);
      g.cards_left = moveCount(g.cards_left, t);
      g.log = [...g.log, { key, kind: 'return', t }];
      if (g.turn === t.from) g.remaining_ms = null;
      return g;
    }
    case 'played':
    case 'passed': {
      const cards: Card[] = ev.type === 'played' ? playOrder(d.cards ?? [], d.pattern ?? null, g.level) : [];
      const rec: PlayRecord = { seat: d.seat, cards, pattern: ev.type === 'played' ? (d.pattern ?? null) : null };
      g.phase = 'playing';
      g.last_plays = trackTrick(g.last_plays, lastNonPassSeat(g.history), { ...rec, key, auto: d.auto });
      g.history = [...g.history, rec];
      g.log = [...g.log, { key, kind: 'play', seat: d.seat, cards, pattern: rec.pattern, auto: d.auto }];
      if (ev.type === 'played') {
        if (Array.isArray(d.cards_left) && d.cards_left.length === N) g.cards_left = d.cards_left.map(Number);
        else {
          g.cards_left = [...g.cards_left];
          g.cards_left[d.seat] = Math.max(0, (g.cards_left[d.seat] ?? 0) - cards.length);
        }
        g.to_beat = rec;
        const own = g.hands[d.seat];
        if (own) {
          g.hands = [...g.hands];
          g.hands[d.seat] = removeCards4(own, cards);
        }
      }
      if (g.turn === d.seat) g.remaining_ms = null;
      return g;
    }
    case 'player.out':
      if (!g.order.includes(d.seat)) g.order = [...g.order, d.seat];
      g.log = [...g.log, { key, kind: 'out', seat: d.seat, place: d.place ?? g.order.length }];
      return g;
    case 'game.finished': {
      g.phase = 'finished';
      g.turn = null;
      g.remaining_ms = null;
      g.result = d.result ?? null;
      if (g.result?.order) g.order = [...g.result.order];
      if (Array.isArray(d.hands) && d.hands.length === N) {
        g.hands = d.hands.map((h: Card[]) => sortByValue(h ?? [], g.level));
        g.cards_left = g.hands.map((h) => h!.length);
      }
      if (g.result) g.log = [...g.log, { key, kind: 'finish', result: g.result }];
      return g;
    }
    default:
      return g0;
  }
}

const REPLAY_SKIP = new Set(['hello', 'room.updated', 'resync', 'pong', 'reply']);

/** Every intermediate state of a finished hand, replayed from the deal (one step per event, like ddz). */
export function buildGuandanReplayStates(rep: GuandanReplay): GuandanView[] {
  const level = asLevel(rep.level ?? rep.result?.level);
  const initial = (rep.initial_hands ?? []).map((h) => sortByValue(h, level));
  const withHands = (v: GuandanView): GuandanView => ({ ...v, hands: fill<Card[] | null>(null).map((_, i) => (initial[i] ? [...initial[i]!] : null)) });
  const states: GuandanView[] = [];
  let cur: GuandanView | null = null;
  let seq = 0;
  for (const ev of rep.events ?? []) {
    if (REPLAY_SKIP.has(ev.type)) continue;
    seq = typeof ev.seq === 'number' ? ev.seq : seq + 1;
    let next = applyGuandanEvent(cur, ev, seq, ev.ts ?? 0, { viewer: null });
    if (!next || next === cur) continue;
    // Public events carry no hands; start from the recorded deal.
    if (ev.type === 'game.started') next = withHands({ ...next, players: next.players.length ? next.players : normPlayers(rep.players) });
    cur = { ...next, remaining_ms: null };
    states.push(cur);
  }
  if (states.length === 0) {
    // No events recorded: show the final snapshot with the dealt hands.
    states.push(withHands(guandanFromSnapshot(rep, 0)));
  }
  return states;
}

/** Short result line, e.g. "0 队升 3 级 · 打 7" or "0 队过 A 赢下一场". */
export function gdResultSummary(r: GdResult): string {
  if (r.match_winner !== null && r.match_winner !== undefined) return `${r.match_winner} 队过 A 赢下一场`;
  return `${r.winner_team} 队升 ${r.upgrade} 级 · 打 ${levelLabel(r.level)}`;
}
