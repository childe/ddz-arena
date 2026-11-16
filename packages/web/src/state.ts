// Pure table state: built from a snapshot (GET room / game / replay) and advanced by events.
// Shared by the live room view and the replay view.
import { removeCards4, sortCards } from '@ddz/engine';
import {
  type AnyPublicGame,
  type AnyReplay,
  type Card,
  type GameResult,
  type GameType,
  type HoldemLegal,
  type HoldemPublicGame,
  type HoldemReplay,
  type Phase,
  type Player,
  type PlayRecord,
  type PublicGame,
  type Replay,
  type Room,
  type WsEvent,
  gameTypeOf,
  isHoldemGame,
} from './api.ts';
import { type HoldemView, applyHoldemEvent, buildHoldemReplayStates, holdemFromSnapshot } from './holdemState.ts';

export interface PlayView extends PlayRecord {
  /** Unique key so the card animation re-runs for each new play. */
  key: string;
  auto?: boolean;
}

export type LogEntry =
  | { key: string; kind: 'start'; first_bidder: number | null }
  | { key: string; kind: 'bid'; seat: number; score: number; auto?: boolean }
  | { key: string; kind: 'landlord'; seat: number; bottom: Card[]; high_bid: number }
  | { key: string; kind: 'play'; seat: number; cards: Card[]; pattern: PlayRecord['pattern']; auto?: boolean }
  | { key: string; kind: 'redeal'; count: number }
  | { key: string; kind: 'finish'; result: GameResult };

export interface GameView {
  game_id: string;
  phase: Phase;
  players: Player[];
  /** Number of seats: 3 (ddz) or 4 (ddz4). */
  n: number;
  first_bidder: number | null;
  bids: { seat: number; score: number; auto?: boolean }[];
  high_bid: number;
  landlord: number | null;
  bottom: Card[] | null;
  turn: number | null;
  /** Milliseconds left on the clock at local time `clock_at`. */
  remaining_ms: number | null;
  clock_at: number;
  to_beat: PlayRecord | null;
  can_pass: boolean;
  cards_left: number[];
  multiplier: number;
  history: PlayRecord[];
  result: GameResult | null;
  turn_seq: number;
  /** Most recent action per seat in the current trick (cards: [] = 不出). */
  last_plays: (PlayView | null)[];
  /** Bid per seat in this deal (0 = 不叫), null if not yet bid. */
  last_bids: (number | null)[];
  /** Hands we know: own hand (player), all hands (replay), or remaining hands at the end. */
  hands: (Card[] | null)[];
  redeals: number;
  log: LogEntry[];
}

export interface TableState {
  room: Room | null;
  /** Game type of the room / replay; decides which reducer and table are used. */
  gameType: GameType;
  /** Dou Dizhu (ddz / ddz4) game. */
  game: GameView | null;
  /** Hold'em hand. */
  holdem: HoldemView | null;
  /** Last applied event seq (0 = unknown). */
  seq: number;
  /** bot_id of the viewer, to place `game.started.hand`. */
  viewer: string | null;
}

export const emptyTable = (viewer: string | null = null): TableState => ({
  room: null,
  gameType: 'ddz',
  game: null,
  holdem: null,
  seq: 0,
  viewer,
});

const fill = <T,>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

/** Seats of a Dou Dizhu game type. */
export const ddzSeats = (t: GameType): number => (t === 'ddz4' ? 4 : 3);
/** Cards dealt per player (before the bottom). */
export const ddzHandSize = (n: number): number => (n === 4 ? 25 : 17);
/** Bottom cards. */
export const ddzBottomSize = (n: number): number => (n === 4 ? 8 : 3);

function newGame(game_id: string, players: Player[], first_bidder: number | null, cards_left: number[] | null, now: number, n: number): GameView {
  return {
    game_id,
    phase: 'bidding',
    n,
    players: players.map((p, i) => ({ ...p, seat: typeof p.seat === 'number' ? p.seat : i })),
    first_bidder,
    bids: [],
    high_bid: 0,
    landlord: null,
    bottom: null,
    turn: first_bidder,
    remaining_ms: null,
    clock_at: now,
    to_beat: null,
    can_pass: false,
    cards_left: cards_left ?? fill(n, ddzHandSize(n)),
    multiplier: 1,
    history: [],
    result: null,
    turn_seq: 0,
    last_plays: fill(n, null),
    last_bids: fill(n, null),
    hands: fill(n, null),
    redeals: 0,
    log: [{ key: `start-${game_id}-${now}`, kind: 'start', first_bidder }],
  };
}

/** Puts a play/pass into the per-seat "current trick" view, clearing it when the seat leads. */
function trackTrick(last: (PlayView | null)[], lastNonPass: number | null, rec: PlayView): (PlayView | null)[] {
  const out = rec.cards.length > 0 && (lastNonPass === null || lastNonPass === rec.seat) ? fill<PlayView | null>(last.length, null) : [...last];
  out[rec.seat] = rec;
  return out;
}

function lastNonPassSeat(history: PlayRecord[]): number | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.cards.length > 0) return history[i]!.seat;
  return null;
}

function normCardsLeft(prev: number[], v: unknown, seat?: number): number[] {
  if (Array.isArray(v) && v.length === prev.length) return v.map(Number);
  if (typeof v === 'number' && seat !== undefined) {
    const out = [...prev];
    out[seat] = v;
    return out;
  }
  return prev;
}

/** Builds the game view from a PublicGame / PlayerGame snapshot. */
export function gameFromSnapshot(g: PublicGame, now: number, ownHand?: { seat: number; hand: Card[] }, nSeats?: number): GameView {
  const n = nSeats ?? (Array.isArray(g.cards_left) && g.cards_left.length >= 3 ? g.cards_left.length : ddzSeats(gameTypeOf(g.game)));
  const cl = Array.isArray(g.cards_left) && g.cards_left.length === n ? g.cards_left : null;
  const v = newGame(g.game_id, g.players ?? [], g.first_bidder ?? null, cl, now, n);
  v.phase = g.phase;
  v.bids = [...(g.bids ?? [])];
  v.high_bid = g.high_bid ?? 0;
  v.landlord = g.landlord ?? null;
  v.bottom = g.bottom ?? null;
  v.turn = g.phase === 'finished' ? null : (g.turn ?? null);
  v.remaining_ms = g.remaining_ms ?? null;
  v.to_beat = g.to_beat ?? null;
  v.can_pass = !!g.can_pass;
  v.multiplier = g.multiplier ?? 1;
  v.history = [...(g.history ?? [])];
  v.result = g.result ?? null;
  v.turn_seq = g.turn_seq ?? 0;
  for (const b of v.bids) v.last_bids[b.seat] = b.score;

  const log: LogEntry[] = [v.log[0]!];
  v.bids.forEach((b, i) => log.push({ key: `b${i}`, kind: 'bid', seat: b.seat, score: b.score }));
  if (v.landlord !== null && v.bottom) log.push({ key: 'll', kind: 'landlord', seat: v.landlord, bottom: v.bottom, high_bid: v.high_bid });

  let lastNon: number | null = null;
  v.history.forEach((h, i) => {
    const rec: PlayView = { ...h, key: `h${i}` };
    v.last_plays = trackTrick(v.last_plays, lastNon, rec);
    if (h.cards.length) lastNon = h.seat;
    log.push({ key: `h${i}`, kind: 'play', seat: h.seat, cards: h.cards, pattern: h.pattern });
  });
  if (v.phase === 'playing' && v.turn !== null) {
    if (!v.to_beat) v.last_plays = fill(n, null);
    else v.last_plays[v.turn] = null;
  }
  if (v.result) log.push({ key: 'fin', kind: 'finish', result: v.result });
  v.log = log;
  if (ownHand) v.hands[ownHand.seat] = sortCards(ownHand.hand);
  return v;
}

/** Own private data from GET /games/{gid}/state: `hand` (Dou Dizhu) or `hole` + `legal` (Hold'em). */
export interface OwnView {
  seat: number;
  hand?: Card[];
  hole?: Card[];
  legal?: HoldemLegal;
}

export function tableFromSnapshot(room: Room | null, game: AnyPublicGame | null, viewer: string | null, now: number, own?: OwnView): TableState {
  const gameType: GameType = room?.game ? gameTypeOf(room.game) : isHoldemGame(game) ? 'holdem' : gameTypeOf(game?.game);
  const base: TableState = { room, gameType, game: null, holdem: null, seq: game?.seq ?? 0, viewer };
  if (!game) return base;
  if (gameType === 'holdem') {
    const hole = own?.hole;
    const ownH = own && hole ? { seat: own.seat, hole, legal: own.legal } : undefined;
    return { ...base, holdem: holdemFromSnapshot(game as HoldemPublicGame, now, room?.seats.length, ownH) };
  }
  const ownHand = own && own.hand ? { seat: own.seat, hand: own.hand } : undefined;
  return { ...base, game: gameFromSnapshot(game as PublicGame, now, ownHand, room ? room.seats.length : undefined) };
}

/** Applies one server event. Duplicate / old seqs are ignored. `now` is the local clock (or event ts in replays). */
export function applyEvent(state: TableState, ev: WsEvent, now: number): TableState {
  if (typeof ev.seq === 'number' && ev.seq <= state.seq) return state;
  const seq = typeof ev.seq === 'number' ? ev.seq : state.seq;
  const d = ev.data ?? {};
  const s: TableState = { ...state, seq };
  const key = `e${seq}`;

  if (ev.type === 'room.updated') {
    if (!d.room) return s;
    return { ...s, room: d.room, gameType: d.room.game ? gameTypeOf(d.room.game) : s.gameType };
  }
  if (state.gameType === 'holdem') {
    const h = applyHoldemEvent(state.holdem, ev, seq, now, { viewer: state.viewer, roomSeats: state.room?.seats.length });
    return h === state.holdem && ev.type !== 'game.started' ? s : { ...s, holdem: h };
  }
  if (ev.type === 'game.started') {
    const prev = state.game;
    const n = state.room?.seats.length ?? prev?.n ?? (Array.isArray(d.cards_left) ? d.cards_left.length : ddzSeats(state.gameType));
    const g = newGame(ev.game_id ?? prev?.game_id ?? '', d.players ?? prev?.players ?? [], d.first_bidder ?? null, normCardsLeft(fill(n, ddzHandSize(n)), d.cards_left), now, n);
    if (prev && prev.game_id === g.game_id && prev.phase !== 'finished') g.redeals = prev.redeals;
    if (Array.isArray(d.hand) && state.viewer) {
      const seat = g.players.find((p) => p.bot_id === state.viewer)?.seat ?? (state.room?.seats.findIndex((x) => x?.bot_id === state.viewer) ?? -1);
      if (seat >= 0) g.hands[seat] = sortCards(d.hand);
    }
    return { ...s, game: g };
  }

  const g0 = state.game;
  if (!g0) return s;
  if (ev.game_id && g0.game_id && ev.game_id !== g0.game_id && ev.type !== 'redeal') return s;
  let g: GameView = { ...g0 };

  switch (ev.type) {
    case 'bid.turn':
      g.phase = 'bidding';
      g.turn = d.seat;
      g.remaining_ms = d.remaining_ms ?? null;
      g.clock_at = now;
      if (typeof d.high_bid === 'number') g.high_bid = d.high_bid;
      g.turn_seq = seq;
      break;
    case 'bid.made': {
      g.bids = [...g.bids, { seat: d.seat, score: d.score, auto: d.auto }];
      if (d.score > g.high_bid) g.high_bid = d.score;
      g.last_bids = [...g.last_bids];
      g.last_bids[d.seat] = d.score;
      g.log = [...g.log, { key, kind: 'bid', seat: d.seat, score: d.score, auto: d.auto }];
      if (g.turn === d.seat) g.remaining_ms = null;
      break;
    }
    case 'landlord.decided': {
      g.landlord = d.landlord;
      g.bottom = d.bottom ?? null;
      if (typeof d.high_bid === 'number') g.high_bid = d.high_bid;
      g.phase = 'playing';
      g.turn = d.landlord;
      g.remaining_ms = null;
      g.cards_left = [...g.cards_left];
      g.cards_left[d.landlord] = (g.cards_left[d.landlord] ?? ddzHandSize(g.n)) + (d.bottom?.length ?? ddzBottomSize(g.n));
      const own = g.hands[d.landlord];
      if (own && d.bottom) {
        g.hands = [...g.hands];
        g.hands[d.landlord] = sortCards([...own, ...d.bottom]);
      }
      g.log = [...g.log, { key, kind: 'landlord', seat: d.landlord, bottom: d.bottom ?? [], high_bid: g.high_bid }];
      break;
    }
    case 'turn':
      g.phase = 'playing';
      g.turn = d.seat;
      g.remaining_ms = d.remaining_ms ?? null;
      g.clock_at = now;
      g.to_beat = d.to_beat ?? null;
      g.can_pass = !!d.can_pass;
      g.turn_seq = seq;
      g.last_plays = g.to_beat ? g.last_plays.map((p, i) => (i === d.seat ? null : p)) : fill(g.n, null);
      break;
    case 'played':
    case 'passed': {
      const cards: Card[] = ev.type === 'played' ? sortCards(d.cards ?? []) : [];
      const rec: PlayRecord = { seat: d.seat, cards, pattern: ev.type === 'played' ? (d.pattern ?? null) : null };
      const view: PlayView = { ...rec, key, auto: d.auto };
      g.last_plays = trackTrick(g.last_plays, lastNonPassSeat(g.history), view);
      g.history = [...g.history, rec];
      g.log = [...g.log, { key, kind: 'play', seat: d.seat, cards, pattern: rec.pattern, auto: d.auto }];
      if (ev.type === 'played') {
        const fallback = [...g.cards_left];
        fallback[d.seat] = Math.max(0, (fallback[d.seat] ?? 0) - cards.length);
        g.cards_left = d.cards_left !== undefined ? normCardsLeft(fallback, d.cards_left, d.seat) : fallback;
        if (typeof d.multiplier === 'number') g.multiplier = d.multiplier;
        g.to_beat = rec;
        const own = g.hands[d.seat];
        if (own) {
          // Multiset removal: ddz4 hands can hold two copies of the same card.
          g.hands = [...g.hands];
          g.hands[d.seat] = removeCards4(own, cards);
        }
      }
      if (g.turn === d.seat) g.remaining_ms = null;
      break;
    }
    case 'redeal':
      g.redeals = typeof d.count === 'number' ? d.count : g.redeals + 1;
      g.turn = null;
      g.remaining_ms = null;
      g.log = [...g.log, { key, kind: 'redeal', count: g.redeals }];
      break;
    case 'game.finished': {
      g.phase = 'finished';
      g.turn = null;
      g.remaining_ms = null;
      g.result = d.result ?? null;
      if (g.result && typeof g.result.multiplier === 'number' && g.result.kind === 'win') g.multiplier = g.result.multiplier;
      if (Array.isArray(d.hands) && d.hands.length === g.n) {
        g.hands = d.hands.map((h: Card[]) => sortCards(h ?? []));
        g.cards_left = g.hands.map((h) => h!.length);
      }
      if (g.result) g.log = [...g.log, { key, kind: 'finish', result: g.result }];
      break;
    }
    default:
      return s;
  }
  return { ...s, game: g };
}

/** Remaining ms on the clock at local time `now`. */
export function clockLeft(g: GameView, now: number): number | null {
  if (g.remaining_ms === null) return null;
  return Math.max(0, g.remaining_ms - (now - g.clock_at));
}

/** Display name for a seat, preferring the live room, then the game players. */
export function seatName(state: TableState, seat: number): string {
  return (
    state.room?.seats[seat]?.name ??
    state.game?.players.find((p) => p.seat === seat)?.name ??
    state.holdem?.players.find((p) => p.seat === seat)?.name ??
    `座位 ${seat}`
  );
}

const REPLAY_SKIP = new Set(['hello', 'room.updated', 'resync', 'pong', 'reply']);

/** Reconstructs every intermediate table state by replaying the events from the initial deal. */
export function buildReplayStates(rep0: AnyReplay): TableState[] {
  if (isHoldemGame(rep0) || 'holes' in rep0) {
    return buildHoldemReplayStates(rep0 as HoldemReplay).map((h, i) => ({ ...emptyTable(), gameType: 'holdem', holdem: h, seq: i }));
  }
  const rep = rep0 as Replay;
  const initialHands = (rep.initial_hands ?? []).map((h) => sortCards(h));
  const gameType: GameType = initialHands.length === 4 ? 'ddz4' : gameTypeOf(rep.game);
  const n = initialHands.length >= 3 ? initialHands.length : ddzSeats(gameType);
  const players = rep.players ?? [];
  const blank: GameView = gameFromSnapshot(
    {
      ...rep,
      phase: 'bidding',
      bids: [],
      high_bid: 0,
      landlord: null,
      bottom: null,
      turn: rep.first_bidder,
      remaining_ms: null,
      to_beat: null,
      can_pass: false,
      cards_left: initialHands.map((h) => h.length),
      multiplier: 1,
      history: [],
      result: null,
      players,
    },
    0,
    undefined,
    n,
  );
  blank.hands = initialHands.map((h) => [...h]);
  let s: TableState = { ...emptyTable(), gameType, game: blank };
  const states = [s];
  for (const ev of rep.events ?? []) {
    if (REPLAY_SKIP.has(ev.type)) continue;
    let next = applyEvent(s, ev, ev.ts ?? 0);
    if (next === s) continue;
    if (ev.type === 'game.started' && next.game) {
      // Public events carry no hands; restore the recorded deal.
      next = { ...next, game: { ...next.game, hands: initialHands.map((h) => [...h]) } };
    }
    s = next;
    // A leading game.started replaces the synthetic initial state instead of adding a step.
    if (ev.type === 'game.started' && states.length === 1) states[0] = s;
    else states.push(s);
  }
  return states;
}

