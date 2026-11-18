// Gongzhu table state (docs/gongzhu.md section 5): built from a snapshot (GET room / game / replay) and
// advanced by events. Always 4 seats, each on its own.
import { EXPOSABLE, scoreTaken, sortGz } from '@ddz/engine';
import type { Card, GongzhuPublicGame, GongzhuReplay, GzPhase, GzPlayRecord, GzResult, GzTrickRecord, Player, WsEvent } from './api.ts';

/** One expose decision, in the order the seats made them. */
export interface GzExposeRecord {
  seat: number;
  cards: Card[];
  auto?: boolean;
  /** Exposed for this seat because the other three were exposed (`cards` then lists all its exposed cards). */
  forced?: Card;
}

export interface GongzhuView {
  game_id: string;
  phase: GzPhase;
  players: Player[];
  n: 4;
  hand_no: number;
  /** Cumulative points before this hand. */
  totals: number[];
  first_leader: number;
  /** Cards each seat exposed. */
  exposed: Card[][];
  /** Expose decisions made so far (all four once play starts). */
  exposes: GzExposeRecord[];
  turn: number | null;
  remaining_ms: number | null;
  clock_at: number;
  turn_seq: number;
  /** Trick shown in the middle: the one in progress, or the last completed one until the next card is led. */
  trick: GzTrickRecord | null;
  /** Completed tricks. */
  tricks: GzTrickRecord[];
  /** Scoring cards each seat took so far. */
  taken: Card[][];
  cards_left: number[];
  /** Known hands (own hand live, all hands in replays, remaining hands at the end). */
  hands: (Card[] | null)[];
  result: GzResult | null;
}

const N = 4;
const fill = <T,>(v: T): T[] => Array.from({ length: N }, () => v);
const suitOf = (c: Card) => c[1]!;

/** Names of the exposable cards. */
export const GZ_CARD_NAMES: Record<string, string> = { QS: '猪', JD: '羊', TC: '变压器', AH: '红桃 A' };

/** Points of each seat's taken cards so far (exposed cards double their effect). */
export function handPoints(v: GongzhuView): number[] {
  if (v.result) return v.result.points;
  const ex = v.exposed.flat();
  return v.taken.map((t) => scoreTaken(t, ex));
}

/** True while the trick in the middle still takes cards (the next play joins it). */
const trickOpen = (t: GzTrickRecord | null): t is GzTrickRecord => !!t && t.winner === null && t.plays.length < N;

/** Cards in `seat`'s hand that may be exposed. */
export function exposableCards(v: GongzhuView, seat: number): Card[] {
  const hand = v.hands[seat] ?? [];
  return EXPOSABLE.filter((c) => hand.includes(c));
}

/**
 * Cards the seat on turn may play (mirrors GongzhuGame.legalCards): follow the led suit when possible; an
 * exposed card may not be played in the first round of its suit unless it is the only card of that suit.
 */
export function legalCards(v: GongzhuView, seat: number): Card[] {
  const hand = v.hands[seat];
  if (v.phase !== 'playing' || v.turn !== seat || !hand) return [];
  const ledBefore = new Set(v.tricks.map((t) => (t.plays[0] ? suitOf(t.plays[0].card) : '')));
  const locked = (c: Card) => v.exposed[seat]!.includes(c) && !ledBefore.has(suitOf(c)) && hand.some((x) => x !== c && suitOf(x) === suitOf(c));
  const led = trickOpen(v.trick) && v.trick.plays[0] ? suitOf(v.trick.plays[0].card) : null;
  if (led === null) return hand.filter((c) => !locked(c));
  const follow = hand.filter((c) => suitOf(c) === led);
  if (follow.length === 0) return [...hand];
  return follow.filter((c) => !locked(c));
}

function normPlayers(players: Player[] | undefined): Player[] {
  return (players ?? []).map((p, i) => ({ ...p, seat: typeof p.seat === 'number' ? p.seat : i }));
}

const nums = (a: unknown, def: number): number[] => (Array.isArray(a) && a.length === N ? a.map(Number) : fill(def));
const cardLists = (a: unknown): Card[][] => (Array.isArray(a) && a.length === N ? a.map((x) => (Array.isArray(x) ? [...x] : [])) : fill<Card[]>([]).map(() => []));

function blank(game_id: string, players: Player[], d: Partial<GongzhuPublicGame>, now: number): GongzhuView {
  return {
    game_id,
    phase: 'expose',
    players,
    n: 4,
    hand_no: typeof d.hand_no === 'number' ? d.hand_no : 1,
    totals: nums(d.totals, 0),
    first_leader: typeof d.first_leader === 'number' ? d.first_leader : 0,
    exposed: fill<Card[]>([]).map(() => []),
    exposes: [],
    turn: null,
    remaining_ms: null,
    clock_at: now,
    turn_seq: 0,
    trick: null,
    tricks: [],
    taken: fill<Card[]>([]).map(() => []),
    cards_left: nums(d.cards_left, 13),
    hands: fill(null),
    result: null,
  };
}

/** Builds the view from a GongzhuPublicGame / GongzhuPlayerGame snapshot. */
export function gongzhuFromSnapshot(g: GongzhuPublicGame, now: number, own?: { seat: number; hand: Card[] }): GongzhuView {
  const v = blank(g.game_id, normPlayers(g.players), g, now);
  v.phase = g.phase ?? 'playing';
  v.exposed = cardLists(g.exposed);
  v.turn = v.phase === 'finished' ? null : (g.turn ?? null);
  v.remaining_ms = v.phase === 'finished' ? null : (g.remaining_ms ?? null);
  v.turn_seq = g.turn_seq ?? 0;
  v.tricks = (g.tricks ?? []).map((t) => ({ ...t, plays: [...t.plays] }));
  v.trick = g.trick ? { ...g.trick, plays: [...g.trick.plays] } : (v.tricks[v.tricks.length - 1] ?? null);
  v.taken = cardLists(g.taken).map(sortGz);
  v.result = g.result ?? null;
  // Seats decide in order from the first leader; during the expose phase the seat on turn has not yet.
  const decided = v.phase === 'expose' && v.turn !== null ? (v.turn - v.first_leader + N) % N : N;
  for (let i = 0; i < decided; i++) {
    const seat = (v.first_leader + i) % N;
    v.exposes.push({ seat, cards: v.exposed[seat]! });
  }
  if (own && own.seat >= 0 && own.seat < N && Array.isArray(own.hand)) v.hands[own.seat] = sortGz(own.hand);
  return v;
}

/** Applies one event to the gongzhu view (null view: only game.started creates one). */
export function applyGongzhuEvent(
  g0: GongzhuView | null,
  ev: WsEvent,
  seq: number,
  now: number,
  ctx: { viewer: string | null; roomSeatOf?: (botId: string) => number },
): GongzhuView | null {
  const d = ev.data ?? {};
  if (ev.type === 'game.started') {
    const players = normPlayers(d.players ?? g0?.players);
    const v = blank(ev.game_id ?? '', players, d, now);
    if (Array.isArray(d.hand) && ctx.viewer) {
      const seat = players.find((p) => p.bot_id === ctx.viewer)?.seat ?? ctx.roomSeatOf?.(ctx.viewer) ?? -1;
      if (seat >= 0) v.hands[seat] = sortGz(d.hand);
    }
    return v;
  }
  if (!g0) return null;
  if (ev.game_id && g0.game_id && ev.game_id !== g0.game_id) return g0;
  const g: GongzhuView = { ...g0 };

  switch (ev.type) {
    case 'turn':
      if (d.phase === 'expose' || d.phase === 'playing') g.phase = d.phase;
      g.turn = d.seat;
      g.remaining_ms = d.remaining_ms ?? null;
      g.clock_at = now;
      g.turn_seq = seq;
      // Keep showing a completed trick until the next card is led.
      if (d.trick) g.trick = { ...d.trick, plays: [...d.trick.plays] };
      return g;
    case 'exposed': {
      const cards: Card[] = Array.isArray(d.cards) ? d.cards : [];
      g.exposed = g.exposed.map((e, i) => (i === d.seat ? [...cards] : e));
      g.exposes = [...g.exposes, { seat: d.seat, cards, auto: d.auto, forced: typeof d.forced === 'string' ? d.forced : undefined }];
      if (g.turn === d.seat) g.remaining_ms = null;
      return g;
    }
    case 'played': {
      const rec: GzPlayRecord = { seat: d.seat, card: d.card, auto: d.auto };
      g.phase = 'playing';
      g.trick = trickOpen(g.trick) ? { ...g.trick, plays: [...g.trick.plays, rec] } : { leader: d.seat, plays: [rec], winner: null };
      if (Array.isArray(d.cards_left) && d.cards_left.length === N) g.cards_left = d.cards_left.map(Number);
      else g.cards_left = g.cards_left.map((n, i) => (i === d.seat ? Math.max(0, n - 1) : n));
      const own = g.hands[d.seat];
      if (own) g.hands = g.hands.map((h, i) => (i === d.seat ? own.filter((c) => c !== d.card) : h));
      if (g.turn === d.seat) g.remaining_ms = null;
      return g;
    }
    case 'trick.won': {
      // Prefer the plays we saw (they carry `auto`); fall back to the event's list.
      const plays: GzPlayRecord[] = g.trick && g.trick.plays.length === N ? g.trick.plays : Array.isArray(d.plays) ? d.plays : [];
      const done: GzTrickRecord = { leader: plays[0]?.seat ?? d.seat, plays, winner: d.seat };
      g.trick = done;
      g.tricks = [...g.tricks, done];
      const cards: Card[] = Array.isArray(d.cards) ? d.cards : [];
      if (cards.length) g.taken = g.taken.map((t, i) => (i === d.seat ? sortGz([...t, ...cards]) : t));
      return g;
    }
    case 'game.finished': {
      g.phase = 'finished';
      g.turn = null;
      g.remaining_ms = null;
      g.result = d.result ?? null;
      if (g.result) {
        if (Array.isArray(g.result.taken)) g.taken = cardLists(g.result.taken).map(sortGz);
        if (Array.isArray(g.result.exposed)) g.exposed = cardLists(g.result.exposed);
      }
      if (Array.isArray(d.hands) && d.hands.length === N) {
        g.hands = d.hands.map((h: Card[]) => sortGz(h ?? []));
        g.cards_left = g.hands.map((h) => h!.length);
      }
      return g;
    }
    default:
      return g0;
  }
}

const REPLAY_SKIP = new Set(['hello', 'room.updated', 'resync', 'pong', 'reply']);

/** Every intermediate state of a finished hand, replayed from the deal (one step per event). */
export function buildGongzhuReplayStates(rep: GongzhuReplay): GongzhuView[] {
  const initial = (rep.initial_hands ?? []).map((h) => sortGz(h));
  const withHands = (v: GongzhuView): GongzhuView => ({ ...v, hands: fill<Card[] | null>(null).map((_, i) => (initial[i] ? [...initial[i]!] : null)) });
  const states: GongzhuView[] = [];
  let cur: GongzhuView | null = null;
  let seq = 0;
  for (const ev of rep.events ?? []) {
    if (REPLAY_SKIP.has(ev.type)) continue;
    seq = typeof ev.seq === 'number' ? ev.seq : seq + 1;
    let next = applyGongzhuEvent(cur, ev, seq, ev.ts ?? 0, { viewer: null });
    if (!next || next === cur) continue;
    // Public events carry no hands; start from the recorded deal.
    if (ev.type === 'game.started') next = withHands({ ...next, players: next.players.length ? next.players : normPlayers(rep.players) });
    cur = { ...next, remaining_ms: null };
    states.push(cur);
  }
  if (states.length === 0) {
    // No events recorded: show the final snapshot with the dealt hands.
    states.push(withHands(gongzhuFromSnapshot(rep, 0)));
  }
  return states;
}

/** Short result line, e.g. "全红" or "本场结束". */
export function gzResultSummary(r: GzResult): string {
  const parts: string[] = [];
  if (r.all_hearts !== null && r.all_hearts !== undefined) parts.push('全红');
  if (r.match_over) parts.push('本场结束');
  return parts.join(' · ');
}

/** "+100" / "-50" / "0". */
export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
