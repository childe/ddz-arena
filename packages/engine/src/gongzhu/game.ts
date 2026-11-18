import { type Card, isValidCard } from '../cards.ts';
import { GameError } from '../game.ts';
import { createRng, shuffle } from '../rng.ts';
import {
  type GzSuit, EXPOSABLE, GOAT, HEART_ACE, PIG, SCORING_COUNT, TRANSFORMER,
  fullDeckGz, gzRank, heartPoints, isScoring, sortGz, suitOf,
} from './cards.ts';

export type GzSeat = 0 | 1 | 2 | 3;
export type GzPhase = 'expose' | 'playing' | 'finished';
export type GzHands = [Card[], Card[], Card[], Card[]];
type Four<T> = [T, T, T, T];

export const GZ_SEATS: GzSeat[] = [0, 1, 2, 3];
export const GZ_HAND_SIZE = 13;
/** A match ends after the hand in which some player's total drops to this or lower. */
export const GZ_MATCH_LOSS = -1000;
const next = (s: GzSeat): GzSeat => ((s + 1) % 4) as GzSeat;

/** State carried from one hand to the next within a match. */
export interface GongzhuMatch {
  /** 1-based hand number within the current match. */
  handNo: number;
  /** Cumulative points before this hand. */
  totals: Four<number>;
  /** Who leads this hand: the previous hand's pig taker; null for the first hand (holder of 2C). */
  leader: GzSeat | null;
}

export interface GzPlay {
  seat: GzSeat;
  card: Card;
}

export interface GzTrick {
  leader: GzSeat;
  plays: GzPlay[];
  /** Set once all four have played. */
  winner: GzSeat | null;
}

/** Field names follow the `game.finished` event (docs/gongzhu.md). */
export interface GzResult {
  /** Points of this hand per seat. */
  points: Four<number>;
  totals_before: Four<number>;
  totals_after: Four<number>;
  /** Scoring cards each seat took. */
  taken: Four<Card[]>;
  /** Cards each seat exposed. */
  exposed: Four<Card[]>;
  /** Seat that took all 13 hearts, if any. */
  all_hearts: GzSeat | null;
  /** Seat that took the pig. */
  pig: GzSeat | null;
  /** Seats whose total reached GZ_MATCH_LOSS; the match is over when non-empty. */
  losers: GzSeat[];
  match_over: boolean;
  /** Platform score per seat: (4 × points − sum of points) / 10. Always sums to zero. */
  scores: Four<number>;
}

export function newGzMatch(): GongzhuMatch {
  return { handNo: 1, totals: [0, 0, 0, 0], leader: null };
}

/** The match state for the hand after one that ended with `result`. A finished match starts over. */
export function nextGzMatch(match: GongzhuMatch, result: GzResult): GongzhuMatch {
  if (result.match_over) return newGzMatch();
  return { handNo: match.handNo + 1, totals: [...result.totals_after], leader: result.pig };
}

/**
 * Points for one player's taken cards. Hearts sum to −200, or +200 when one player takes all 13 (全红),
 * and then the pig counts +100 instead of −100. The goat is +100. The transformer doubles the rest, or is
 * +50 on its own (no other scoring card). Exposing doubles a card's effect: the heart ace doubles all
 * hearts, an exposed transformer multiplies by 4 (or is +100 alone).
 */
export function scoreTaken(taken: Card[], exposed: Iterable<Card>): number {
  const ex = new Set(exposed);
  const has = (c: Card) => taken.includes(c);
  const hearts = taken.filter((c) => suitOf(c) === 'H');
  const allHearts = hearts.length === 13;
  const hm = ex.has(HEART_ACE) ? 2 : 1;
  let pts = (allHearts ? 200 : hearts.reduce((n, c) => n + heartPoints(c), 0)) * hm;
  if (has(PIG)) pts += (allHearts ? 100 : -100) * (ex.has(PIG) ? 2 : 1);
  if (has(GOAT)) pts += 100 * (ex.has(GOAT) ? 2 : 1);
  if (has(TRANSFORMER)) {
    const tm = ex.has(TRANSFORMER) ? 2 : 1;
    pts = hearts.length === 0 && !has(PIG) && !has(GOAT) ? 50 * tm : pts * 2 * tm;
  }
  return pts;
}

/** Settles a hand from the scoring cards each seat took. */
export function settleGz(match: GongzhuMatch, taken: Four<Card[]>, exposed: Four<Card[]>): GzResult {
  const allEx = exposed.flat();
  const points = taken.map((t) => scoreTaken(t, allEx)) as Four<number>;
  const sum = points.reduce((a, b) => a + b, 0);
  const after = match.totals.map((t, i) => t + points[i]!) as Four<number>;
  const losers = GZ_SEATS.filter((s) => after[s] <= GZ_MATCH_LOSS);
  const owner = (pred: (t: Card[]) => boolean) => GZ_SEATS.find((s) => pred(taken[s])) ?? null;
  return {
    points,
    totals_before: [...match.totals],
    totals_after: after,
    taken: taken.map((t) => sortGz(t)) as Four<Card[]>,
    exposed: exposed.map((e) => [...e]) as Four<Card[]>,
    all_hearts: owner((t) => t.filter((c) => suitOf(c) === 'H').length === 13),
    pig: owner((t) => t.includes(PIG)),
    losers,
    match_over: losers.length > 0,
    // Points are multiples of 10, so this is an integer.
    scores: points.map((p) => (4 * p - sum) / 10) as Four<number>,
  };
}

/**
 * One hand of Gongzhu: deal 13 each, every seat in turn may expose some of QS / JD / TC / AH, then 13
 * tricks (follow suit, highest card of the led suit wins, winner leads). The hand ends early once all 16
 * scoring cards are taken.
 */
export class GongzhuGame {
  readonly seed: string;
  readonly match: GongzhuMatch;
  readonly initialHands: GzHands;
  hands: GzHands;
  phase: GzPhase = 'expose';
  turn: GzSeat;
  /** Leads the first trick and exposes first. */
  readonly firstLeader: GzSeat;
  exposed: Four<Card[]> = [[], [], [], []];
  /** Seats that have made their expose decision. */
  private exposeCount = 0;
  /** Set when three of the four exposable cards were exposed, so the fourth was exposed for its holder. */
  forcedExpose: { seat: GzSeat; card: Card } | null = null;
  /** Completed tricks. */
  tricks: GzTrick[] = [];
  /** The trick in progress, or null between tricks. */
  trick: GzTrick | null = null;
  /** Scoring cards each seat took. */
  taken: Four<Card[]> = [[], [], [], []];
  result: GzResult | null = null;
  /** Suits led in completed tricks; a suit not in here is still in its first round. */
  private ledBefore = new Set<GzSuit>();

  /** `deal` replaces the shuffled deal (tests and replays). */
  constructor(seed: string, match: GongzhuMatch, deal?: GzHands) {
    this.seed = seed;
    this.match = match;
    const deck = shuffle(fullDeckGz(), createRng(seed));
    const dealt = deal ?? (GZ_SEATS.map((s) => deck.slice(s * GZ_HAND_SIZE, (s + 1) * GZ_HAND_SIZE)) as GzHands);
    this.hands = dealt.map((h) => sortGz(h)) as GzHands;
    this.initialHands = this.hands.map((h) => [...h]) as GzHands;
    this.firstLeader = match.leader ?? (GZ_SEATS.find((s) => this.hands[s].includes('2C')) ?? 0);
    this.turn = this.firstLeader;
  }

  get handNo(): number {
    return this.match.handNo;
  }

  get cardsLeft(): Four<number> {
    return this.hands.map((h) => h.length) as Four<number>;
  }

  /** Number of the trick in progress or about to start, 1-based. */
  get trickNo(): number {
    return this.tricks.length + 1;
  }

  /** The suit led in the current trick, or null when the seat on turn leads. */
  get ledSuit(): GzSuit | null {
    return this.trick?.plays.length ? suitOf(this.trick.plays[0]!.card) : null;
  }

  private expect(phase: GzPhase, seat: GzSeat) {
    if (this.phase !== phase) throw new GameError('WRONG_PHASE', `game is in ${this.phase} phase`);
    if (this.turn !== seat) throw new GameError('NOT_YOUR_TURN', `it is seat ${this.turn}'s turn`);
  }

  /** Cards in `seat`'s hand that may be exposed. */
  exposable(seat: GzSeat): Card[] {
    return EXPOSABLE.filter((c) => this.hands[seat].includes(c));
  }

  /**
   * Exposes any subset of the seat's exposable cards (empty = none). Seats decide in turn. When the last seat
   * has decided and three of the four are exposed, the fourth is exposed too, whoever holds it.
   */
  expose(seat: GzSeat, cards: Card[]): Card[] {
    this.expect('expose', seat);
    const bad = cards.filter((c) => !isValidCard(c));
    if (bad.length) throw new GameError('UNKNOWN_CARD', `unknown card code(s): ${bad.join(', ')}`, { cards: bad });
    if (new Set(cards).size !== cards.length) throw new GameError('BAD_EXPOSE', 'duplicate cards');
    const ok = this.exposable(seat);
    const wrong = cards.filter((c) => !ok.includes(c));
    if (wrong.length) throw new GameError('BAD_EXPOSE', `only ${EXPOSABLE.join(' / ')} in your hand can be exposed`, { cards: wrong });
    this.exposed[seat] = EXPOSABLE.filter((c) => cards.includes(c));
    this.exposeCount++;
    if (this.exposeCount === 4) {
      this.forceFourth();
      this.phase = 'playing';
      this.turn = this.firstLeader;
    } else {
      this.turn = next(seat);
    }
    return this.exposed[seat];
  }

  private forceFourth() {
    const shown = this.exposed.flat();
    if (shown.length !== EXPOSABLE.length - 1) return;
    const card = EXPOSABLE.find((c) => !shown.includes(c))!;
    const seat = GZ_SEATS.find((s) => this.hands[s].includes(card))!;
    this.exposed[seat] = EXPOSABLE.filter((c) => c === card || this.exposed[seat].includes(c));
    this.forcedExpose = { seat, card };
  }

  /** True if `card` is exposed and its suit has not been led in an earlier trick. */
  private locked(seat: GzSeat, card: Card): boolean {
    if (!this.exposed[seat].includes(card) || this.ledBefore.has(suitOf(card))) return false;
    // The only card of its suit may always be played.
    return this.hands[seat].some((c) => c !== card && suitOf(c) === suitOf(card));
  }

  /**
   * Cards the seat on turn may play: a card of the led suit when it has one, else any card. An exposed card
   * may not be led or follow in the first round of its suit unless it is the only card of that suit in hand.
   */
  legalCards(): Card[] {
    if (this.phase !== 'playing') return [];
    const seat = this.turn;
    const hand = this.hands[seat];
    const led = this.ledSuit;
    if (led === null) return hand.filter((c) => !this.locked(seat, c));
    const follow = hand.filter((c) => suitOf(c) === led);
    if (follow.length === 0) return [...hand];
    return follow.filter((c) => !this.locked(seat, c));
  }

  /** Plays one card. Returns the trick when this card completed it. */
  play(seat: GzSeat, card: Card): GzTrick | null {
    this.expect('playing', seat);
    if (!isValidCard(card)) throw new GameError('UNKNOWN_CARD', `unknown card code: ${card}`, { cards: [card] });
    const hand = this.hands[seat];
    if (!hand.includes(card)) throw new GameError('CARDS_NOT_IN_HAND', `${card} is not in your hand`, { cards: [card] });
    const led = this.ledSuit;
    if (led !== null && suitOf(card) !== led && hand.some((c) => suitOf(c) === led)) {
      throw new GameError('MUST_FOLLOW_SUIT', `you must follow suit ${led}`, { suit: led });
    }
    // Discarding on another suit's trick is never locked.
    if ((led === null || suitOf(card) === led) && this.locked(seat, card)) {
      throw new GameError('EXPOSED_CARD_LOCKED', `exposed ${card} cannot be played in the first round of its suit`, { card });
    }
    if (!this.trick) this.trick = { leader: seat, plays: [], winner: null };
    const t = this.trick;
    t.plays.push({ seat, card });
    this.hands[seat] = hand.filter((c) => c !== card);
    if (t.plays.length < 4) {
      this.turn = next(seat);
      return null;
    }
    const suit = suitOf(t.plays[0]!.card);
    t.winner = t.plays.reduce((w, p) => (suitOf(p.card) === suit && gzRank(p.card) > gzRank(w.card) ? p : w)).seat;
    this.taken[t.winner].push(...t.plays.map((p) => p.card).filter(isScoring));
    this.ledBefore.add(suit);
    this.tricks.push(t);
    this.trick = null;
    this.turn = t.winner;
    const takenCount = this.taken.reduce((n, x) => n + x.length, 0);
    if (takenCount === SCORING_COUNT || this.tricks.length === GZ_HAND_SIZE) {
      this.phase = 'finished';
      this.result = settleGz(this.match, this.taken, this.exposed);
    }
    return t;
  }

  /**
   * Action for a seat that timed out: expose nothing; otherwise play the lowest legal card, preferring
   * cards that are not scoring cards.
   */
  autoAction(): { kind: 'expose'; cards: Card[] } | { kind: 'play'; card: Card } {
    if (this.phase === 'expose') return { kind: 'expose', cards: [] };
    if (this.phase !== 'playing') throw new GameError('WRONG_PHASE', 'game is finished');
    const legal = this.legalCards();
    const plain = legal.filter((c) => !isScoring(c));
    const pool = plain.length ? plain : legal;
    return { kind: 'play', card: pool.reduce((lo, c) => (gzRank(c) < gzRank(lo) ? c : lo)) };
  }
}
