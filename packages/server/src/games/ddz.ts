// Dou Dizhu adapter shared by the 3-player (`ddz`) and 4-player (`ddz4`) engines, which have the same shape.
import {
  Game, GameError, legalMoves, RANK_LABELS, PATTERN_TYPES, Ddz4Game, legalMoves4, PATTERN_TYPES4,
  type Card, type Pattern, type PatternType,
} from '@ddz/engine';
import { badRequest } from '../errors.ts';
import type { ActResult, Emit, GameSession, GameType, GameVariant, PlayerOutcome } from './types.ts';

interface DdzPlay {
  seat: number;
  cards: Card[];
  pattern: Pattern | null;
}

/** The engine surface used here; both Game and Ddz4Game provide it. */
export interface DdzEngine {
  readonly seed: string;
  readonly firstBidder: number;
  readonly initialHands: Card[][];
  hands: Card[][];
  bottom: Card[];
  phase: 'bidding' | 'playing' | 'finished';
  turn: number;
  bids: { seat: number; score: number }[];
  highBid: number;
  landlord: number | null;
  lastPlay: DdzPlay | null;
  readonly toBeat: Pattern | null;
  history: DdzPlay[];
  result: DdzResult | null;
  readonly multiplier: number;
  bid(seat: number, score: number): void;
  play(seat: number, cards: Card[], hint?: string): Pattern | null;
  autoAction(): { kind: 'bid'; score: number } | { kind: 'play'; cards: Card[] };
}

interface DdzResult {
  kind: 'win' | 'nobid';
  winner: 'landlord' | 'farmers' | null;
  winnerSeat: number | null;
  landlord: number | null;
  base: number;
  bombs: number;
  spring: boolean;
  antiSpring: boolean;
  multiplier: number;
  scores: number[];
}

export interface DdzRules {
  type: GameType;
  seats: number;
  create(seed: string): DdzEngine;
  legalMoves(hand: Card[], last: Pattern | null): { cards: Card[]; pattern: Pattern }[];
  patternTypes: readonly string[];
}

export const serializePattern = (p: Pattern | null) =>
  p && { type: p.type, rank: RANK_LABELS[p.main], length: p.length };
const serializePlay = (p: DdzPlay) => ({ seat: p.seat, cards: p.cards, pattern: serializePattern(p.pattern) });

export function serializeDdzResult(r: DdzResult | null) {
  if (!r) return null;
  return {
    kind: r.kind, winner: r.winner, winner_seat: r.winnerSeat, landlord: r.landlord, base: r.base, bombs: r.bombs,
    spring: r.spring, anti_spring: r.antiSpring, multiplier: r.multiplier, scores: r.scores,
  };
}

class DdzSession implements GameSession {
  readonly seats: number[];
  private g: DdzEngine;
  private rules: DdzRules;

  constructor(rules: DdzRules, seed: string) {
    this.rules = rules;
    this.g = rules.create(seed);
    this.seats = [...Array(rules.seats).keys()];
  }

  get seed() {
    return this.g.seed;
  }
  get finished() {
    return this.g.phase === 'finished';
  }
  get turn() {
    return this.finished ? null : this.g.turn;
  }
  get redeal() {
    return this.g.result?.kind === 'nobid';
  }

  startEvents(): Emit[] {
    const g = this.g;
    const priv: Record<number, Record<string, unknown>> = {};
    for (const s of this.seats) priv[s] = { hand: g.hands[s] };
    return [{ type: 'game.started', data: { first_bidder: g.firstBidder, cards_left: g.hands.map((h) => h.length) }, priv }];
  }

  turnEvent(): Emit {
    const g = this.g;
    if (g.phase === 'bidding') return { type: 'bid.turn', data: { seat: g.turn, high_bid: g.highBid } };
    return { type: 'turn', data: { seat: g.turn, to_beat: this.toBeat(), can_pass: g.toBeat !== null } };
  }

  turnTimeout(config: Record<string, unknown>) {
    return (this.g.phase === 'bidding' ? config.bid_timeout_ms : config.play_timeout_ms) as number;
  }

  private toBeat() {
    const g = this.g;
    return g.phase === 'playing' && g.toBeat && g.lastPlay ? serializePlay(g.lastPlay) : null;
  }

  act(seat: number, op: string, body: Record<string, unknown>): ActResult {
    if (op === 'bid') {
      if (typeof body.score !== 'number') throw new GameError('BAD_BID', 'score must be 0, 1, 2 or 3');
      return { events: this.bid(seat, body.score, false) };
    }
    if (op === 'play') {
      const { cards, pattern } = body;
      if (!Array.isArray(cards) || cards.some((c) => typeof c !== 'string')) throw badRequest('cards must be an array of card codes');
      let hint: PatternType | undefined;
      if (pattern !== undefined && pattern !== null) {
        const t = (pattern as { type?: unknown }).type;
        if (typeof t !== 'string' || !this.rules.patternTypes.includes(t)) throw badRequest('pattern.type is not a known pattern type');
        hint = t as PatternType;
      }
      const events = this.play(seat, cards as Card[], hint, false);
      return { events, reply: { pattern: serializePattern(this.g.history.at(-1)?.pattern ?? null) } };
    }
    throw badRequest(`this game uses bid and play, not ${op}`);
  }

  private bid(seat: number, score: number, auto: boolean): Emit[] {
    const g = this.g;
    g.bid(seat, score);
    const events: Emit[] = [{ type: 'bid.made', data: { seat, score, auto } }];
    if (g.phase === 'playing') events.push({ type: 'landlord.decided', data: { landlord: g.landlord, bottom: g.bottom, high_bid: g.highBid } });
    return events;
  }

  private play(seat: number, cards: Card[], hint: PatternType | undefined, auto: boolean): Emit[] {
    const g = this.g;
    const pattern = g.play(seat, cards, hint);
    if (!pattern) return [{ type: 'passed', data: { seat, auto } }];
    return [{
      type: 'played',
      data: {
        seat, cards: g.history.at(-1)!.cards, pattern: serializePattern(pattern),
        cards_left: g.hands.map((h) => h.length), multiplier: g.multiplier, auto,
      },
    }];
  }

  auto(seat: number): Emit[] {
    const a = this.g.autoAction();
    return a.kind === 'bid' ? this.bid(seat, a.score, true) : this.play(seat, a.cards, undefined, true);
  }

  publicView() {
    const g = this.g;
    return {
      phase: g.phase,
      first_bidder: g.firstBidder,
      bids: g.bids,
      high_bid: g.highBid,
      landlord: g.landlord,
      bottom: g.landlord === null ? null : g.bottom,
      to_beat: this.toBeat(),
      can_pass: g.phase === 'playing' && g.toBeat !== null,
      cards_left: g.hands.map((h) => h.length),
      multiplier: g.multiplier,
      history: g.history.map(serializePlay),
      result: serializeDdzResult(g.result),
    };
  }

  privateView(seat: number) {
    return { hand: this.g.hands[seat] };
  }

  legalMoves(seat: number) {
    const g = this.g;
    if (g.phase !== 'playing' || g.turn !== seat) return { moves: [], can_pass: false };
    const moves = this.rules.legalMoves(g.hands[seat]!, g.toBeat).map((m) => ({ cards: m.cards, pattern: serializePattern(m.pattern) }));
    return { moves, can_pass: g.toBeat !== null };
  }

  finishedData() {
    return { result: serializeDdzResult(this.g.result), hands: this.g.hands, seed: this.g.seed };
  }

  resultData() {
    return serializeDdzResult(this.g.result)!;
  }

  outcomes(): PlayerOutcome[] {
    const g = this.g;
    const r = g.result!;
    return this.seats.map((seat) => ({
      seat,
      score: r.scores[seat]!,
      isLandlord: g.landlord === seat,
      win: r.kind === 'win' && (r.winner === 'landlord') === (g.landlord === seat),
    }));
  }

  replayData() {
    return { seed: this.g.seed, initial_hands: this.g.initialHands };
  }
}

const TIMEOUT_KEYS = ['bid_timeout_ms', 'play_timeout_ms'] as const;

export function ddzVariant(rules: DdzRules): GameVariant {
  return {
    type: rules.type,
    seatCount: () => rules.seats,
    minPlayers: () => rules.seats,
    defaultConfig: { bid_timeout_ms: 10_000, play_timeout_ms: 20_000 },
    parseConfig(raw) {
      const out: Record<string, unknown> = {};
      for (const k of TIMEOUT_KEYS) {
        if (raw[k] === undefined) continue;
        out[k] = timeoutMs(raw[k], k);
      }
      return out;
    },
    maxRedeals: 3,
    create: (seed) => new DdzSession(rules, seed),
  };
}

export function timeoutMs(v: unknown, k: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1000 || v > 120_000) throw badRequest(`${k} must be an integer between 1000 and 120000`);
  return v;
}

export const ddz3 = ddzVariant({
  type: 'ddz',
  seats: 3,
  create: (seed) => new Game(seed) as unknown as DdzEngine,
  legalMoves,
  patternTypes: PATTERN_TYPES,
});

export const ddz4 = ddzVariant({
  type: 'ddz4',
  seats: 4,
  create: (seed) => new Ddz4Game(seed) as unknown as DdzEngine,
  legalMoves: legalMoves4 as unknown as DdzRules['legalMoves'],
  patternTypes: PATTERN_TYPES4,
});
