import { type Card, fullDeck, sortCards, isValidCard, containsAll, removeCards } from './cards.ts';
import { type Pattern, type PatternType, resolve } from './patterns.ts';
import { lowestSingle } from './moves.ts';
import { createRng, shuffle } from './rng.ts';

export type Seat = 0 | 1 | 2;
export type Phase = 'bidding' | 'playing' | 'finished';

export type GameErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'UNKNOWN_CARD'
  | 'BID_TOO_LOW'
  | 'BAD_BID'
  | 'CARDS_NOT_IN_HAND'
  | 'MUST_PLAY'
  | 'INVALID_PATTERN'
  | 'CANNOT_BEAT'
  | 'BAD_ACTION'
  | 'CANNOT_CHECK'
  | 'BAD_AMOUNT'
  | 'PATTERN_MISMATCH'
  | 'BAD_RETURN';

const STATUS: Record<GameErrorCode, number> = {
  WRONG_PHASE: 409,
  NOT_YOUR_TURN: 409,
  UNKNOWN_CARD: 400,
  BAD_BID: 400,
  BID_TOO_LOW: 422,
  CARDS_NOT_IN_HAND: 422,
  MUST_PLAY: 422,
  INVALID_PATTERN: 422,
  CANNOT_BEAT: 422,
  BAD_ACTION: 400,
  CANNOT_CHECK: 422,
  BAD_AMOUNT: 422,
  PATTERN_MISMATCH: 422,
  BAD_RETURN: 422,
};

export class GameError extends Error {
  code: GameErrorCode;
  status: number;
  details?: unknown;
  constructor(code: GameErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export interface PlayRecord {
  seat: Seat;
  /** Empty for a pass. */
  cards: Card[];
  pattern: Pattern | null;
}

export interface GameResult {
  kind: 'win' | 'nobid';
  winner: 'landlord' | 'farmers' | null;
  winnerSeat: Seat | null;
  landlord: Seat | null;
  base: number;
  bombs: number;
  spring: boolean;
  antiSpring: boolean;
  multiplier: number;
  /** Score delta per seat; always sums to zero. */
  scores: [number, number, number];
}

export const nextSeat = (s: Seat): Seat => ((s + 1) % 3) as Seat;

export class Game {
  readonly seed: string;
  readonly firstBidder: Seat;
  readonly initialHands: [Card[], Card[], Card[]];
  hands: [Card[], Card[], Card[]];
  bottom: Card[];
  phase: Phase = 'bidding';
  turn: Seat;
  bids: { seat: Seat; score: number }[] = [];
  highBid = 0;
  highBidder: Seat | null = null;
  landlord: Seat | null = null;
  /** The play currently to beat, or null when the seat on turn leads freely. */
  lastPlay: PlayRecord | null = null;
  bombs = 0;
  playCounts: [number, number, number] = [0, 0, 0];
  history: PlayRecord[] = [];
  result: GameResult | null = null;

  constructor(seed: string) {
    this.seed = seed;
    const rng = createRng(seed);
    const deck = shuffle(fullDeck(), rng);
    this.hands = [sortCards(deck.slice(0, 17)), sortCards(deck.slice(17, 34)), sortCards(deck.slice(34, 51))];
    this.initialHands = [[...this.hands[0]], [...this.hands[1]], [...this.hands[2]]];
    this.bottom = sortCards(deck.slice(51));
    this.firstBidder = Math.floor(rng() * 3) as Seat;
    this.turn = this.firstBidder;
  }

  private expect(phase: Phase, seat: Seat) {
    if (this.phase !== phase) throw new GameError('WRONG_PHASE', `game is in ${this.phase} phase`);
    if (this.turn !== seat) throw new GameError('NOT_YOUR_TURN', `it is seat ${this.turn}'s turn`);
  }

  /** Bid 0 (no bid) or 1..3; must exceed the current high bid. */
  bid(seat: Seat, score: number): void {
    this.expect('bidding', seat);
    if (!Number.isInteger(score) || score < 0 || score > 3) throw new GameError('BAD_BID', 'score must be 0, 1, 2 or 3');
    if (score !== 0 && score <= this.highBid) {
      throw new GameError('BID_TOO_LOW', `bid must be higher than ${this.highBid}`, { high_bid: this.highBid });
    }
    this.bids.push({ seat, score });
    if (score > 0) {
      this.highBid = score;
      this.highBidder = seat;
    }
    if (score === 3 || this.bids.length === 3) {
      if (this.highBidder === null) return this.finishNoBid();
      this.landlord = this.highBidder;
      this.hands[this.landlord] = sortCards([...this.hands[this.landlord], ...this.bottom]);
      this.phase = 'playing';
      this.turn = this.landlord;
      return;
    }
    this.turn = nextSeat(seat);
  }

  /** The pattern the seat on turn must beat, or null if it leads. */
  get toBeat(): Pattern | null {
    if (!this.lastPlay || this.lastPlay.seat === this.turn) return null;
    return this.lastPlay.pattern;
  }

  /** Play cards; an empty array passes. Returns the resolved pattern (null for pass). */
  play(seat: Seat, cards: Card[], hint?: PatternType): Pattern | null {
    this.expect('playing', seat);
    const bad = cards.filter((c) => !isValidCard(c));
    if (bad.length) throw new GameError('UNKNOWN_CARD', `unknown card code(s): ${bad.join(', ')}`, { cards: bad });
    const toBeat = this.toBeat;
    if (cards.length === 0) {
      if (!toBeat) throw new GameError('MUST_PLAY', 'you lead this round and cannot pass');
      this.history.push({ seat, cards: [], pattern: null });
      this.turn = nextSeat(seat);
      return null;
    }
    if (!containsAll(this.hands[seat], cards)) {
      throw new GameError('CARDS_NOT_IN_HAND', 'some cards are not in your hand or are repeated', { cards });
    }
    const r = resolve(cards, toBeat, hint);
    if (!r.ok) throw new GameError(r.code, r.message, { last: this.lastPlay });
    const rec: PlayRecord = { seat, cards: sortCards(cards), pattern: r.pattern };
    this.hands[seat] = removeCards(this.hands[seat], cards);
    this.history.push(rec);
    this.lastPlay = rec;
    this.playCounts[seat]++;
    if (r.pattern.type === 'bomb' || r.pattern.type === 'rocket') this.bombs++;
    if (this.hands[seat].length === 0) this.finishWin(seat);
    else this.turn = nextSeat(seat);
    return r.pattern;
  }

  /** Action taken for a seat that timed out: no bid, pass, or lowest single when leading. */
  autoAction(): { kind: 'bid'; score: number } | { kind: 'play'; cards: Card[] } {
    if (this.phase === 'bidding') return { kind: 'bid', score: 0 };
    if (this.phase === 'playing') return { kind: 'play', cards: this.toBeat ? [] : lowestSingle(this.hands[this.turn]) };
    throw new GameError('WRONG_PHASE', 'game is finished');
  }

  private finishNoBid() {
    this.phase = 'finished';
    this.result = {
      kind: 'nobid', winner: null, winnerSeat: null, landlord: null, base: 0, bombs: 0,
      spring: false, antiSpring: false, multiplier: 0, scores: [0, 0, 0],
    };
  }

  private finishWin(seat: Seat) {
    const landlord = this.landlord!;
    const landlordWins = seat === landlord;
    const farmers = ([0, 1, 2] as Seat[]).filter((s) => s !== landlord);
    const spring = landlordWins && farmers.every((s) => this.playCounts[s] === 0);
    const antiSpring = !landlordWins && this.playCounts[landlord] === 1;
    const multiplier = 2 ** this.bombs * (spring || antiSpring ? 2 : 1);
    const unit = this.highBid * multiplier;
    const scores: [number, number, number] = [0, 0, 0];
    for (const s of farmers) scores[s] = landlordWins ? -unit : unit;
    scores[landlord] = landlordWins ? 2 * unit : -2 * unit;
    this.phase = 'finished';
    this.result = {
      kind: 'win', winner: landlordWins ? 'landlord' : 'farmers', winnerSeat: seat, landlord,
      base: this.highBid, bombs: this.bombs, spring, antiSpring, multiplier, scores,
    };
  }

  /** Current multiplier (bombs so far; spring is only known at the end). */
  get multiplier(): number {
    return this.result?.multiplier ?? 2 ** this.bombs;
  }
}
