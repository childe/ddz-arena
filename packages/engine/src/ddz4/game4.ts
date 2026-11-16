import { type Card, sortCards, isValidCard } from '../cards.ts';
import { type Phase, GameError } from '../game.ts';
import { lowestSingle } from '../moves.ts';
import { createRng, shuffle } from '../rng.ts';
import { fullDeck4, containsAll4, removeCards4 } from './cards4.ts';
import { type Pattern4, type PatternType4, resolve4 } from './patterns4.ts';

export type Ddz4Seat = 0 | 1 | 2 | 3;
export type Ddz4Hands = [Card[], Card[], Card[], Card[]];

export interface Ddz4PlayRecord {
  seat: Ddz4Seat;
  /** Empty for a pass. */
  cards: Card[];
  pattern: Pattern4 | null;
}

export interface Ddz4Result {
  kind: 'win' | 'nobid';
  winner: 'landlord' | 'farmers' | null;
  winnerSeat: Ddz4Seat | null;
  landlord: Ddz4Seat | null;
  base: number;
  bombs: number;
  spring: boolean;
  antiSpring: boolean;
  multiplier: number;
  /** Score delta per seat; always sums to zero. */
  scores: [number, number, number, number];
}

export const DDZ4_SEATS: Ddz4Seat[] = [0, 1, 2, 3];
export const nextSeat4 = (s: Ddz4Seat): Ddz4Seat => ((s + 1) % 4) as Ddz4Seat;

/** 4-player Dou Dizhu with two decks: 25 cards each, 8 in the bottom, landlord plays against 3 farmers. */
export class Ddz4Game {
  readonly seed: string;
  readonly firstBidder: Ddz4Seat;
  readonly initialHands: Ddz4Hands;
  hands: Ddz4Hands;
  bottom: Card[];
  phase: Phase = 'bidding';
  turn: Ddz4Seat;
  bids: { seat: Ddz4Seat; score: number }[] = [];
  highBid = 0;
  highBidder: Ddz4Seat | null = null;
  landlord: Ddz4Seat | null = null;
  /** The play currently to beat, or null when the seat on turn leads freely. */
  lastPlay: Ddz4PlayRecord | null = null;
  bombs = 0;
  playCounts: [number, number, number, number] = [0, 0, 0, 0];
  history: Ddz4PlayRecord[] = [];
  result: Ddz4Result | null = null;

  constructor(seed: string) {
    this.seed = seed;
    const rng = createRng(seed);
    const deck = shuffle(fullDeck4(), rng);
    this.hands = [
      sortCards(deck.slice(0, 25)), sortCards(deck.slice(25, 50)),
      sortCards(deck.slice(50, 75)), sortCards(deck.slice(75, 100)),
    ];
    this.initialHands = [[...this.hands[0]], [...this.hands[1]], [...this.hands[2]], [...this.hands[3]]];
    this.bottom = sortCards(deck.slice(100));
    this.firstBidder = Math.floor(rng() * 4) as Ddz4Seat;
    this.turn = this.firstBidder;
  }

  private expect(phase: Phase, seat: Ddz4Seat) {
    if (this.phase !== phase) throw new GameError('WRONG_PHASE', `game is in ${this.phase} phase`);
    if (this.turn !== seat) throw new GameError('NOT_YOUR_TURN', `it is seat ${this.turn}'s turn`);
  }

  /** Bid 0 (no bid) or 1..3; must exceed the current high bid. */
  bid(seat: Ddz4Seat, score: number): void {
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
    if (score === 3 || this.bids.length === 4) {
      if (this.highBidder === null) return this.finishNoBid();
      this.landlord = this.highBidder;
      this.hands[this.landlord] = sortCards([...this.hands[this.landlord], ...this.bottom]);
      this.phase = 'playing';
      this.turn = this.landlord;
      return;
    }
    this.turn = nextSeat4(seat);
  }

  /** The pattern the seat on turn must beat, or null if it leads. */
  get toBeat(): Pattern4 | null {
    if (!this.lastPlay || this.lastPlay.seat === this.turn) return null;
    return this.lastPlay.pattern;
  }

  /** Play cards; an empty array passes. Returns the resolved pattern (null for pass). */
  play(seat: Ddz4Seat, cards: Card[], hint?: PatternType4): Pattern4 | null {
    this.expect('playing', seat);
    const bad = cards.filter((c) => !isValidCard(c));
    if (bad.length) throw new GameError('UNKNOWN_CARD', `unknown card code(s): ${bad.join(', ')}`, { cards: bad });
    const toBeat = this.toBeat;
    if (cards.length === 0) {
      if (!toBeat) throw new GameError('MUST_PLAY', 'you lead this round and cannot pass');
      this.history.push({ seat, cards: [], pattern: null });
      this.turn = nextSeat4(seat);
      return null;
    }
    if (!containsAll4(this.hands[seat], cards)) {
      throw new GameError('CARDS_NOT_IN_HAND', 'some cards are not in your hand (or not enough copies)', { cards });
    }
    const r = resolve4(cards, toBeat, hint);
    if (!r.ok) throw new GameError(r.code, r.message, { last: this.lastPlay });
    const rec: Ddz4PlayRecord = { seat, cards: sortCards(cards), pattern: r.pattern };
    this.hands[seat] = removeCards4(this.hands[seat], cards);
    this.history.push(rec);
    this.lastPlay = rec;
    this.playCounts[seat]++;
    if (r.pattern.type === 'bomb' || r.pattern.type === 'rocket') this.bombs++;
    if (this.hands[seat].length === 0) this.finishWin(seat);
    else this.turn = nextSeat4(seat);
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
      spring: false, antiSpring: false, multiplier: 0, scores: [0, 0, 0, 0],
    };
  }

  private finishWin(seat: Ddz4Seat) {
    const landlord = this.landlord!;
    const landlordWins = seat === landlord;
    const farmers = DDZ4_SEATS.filter((s) => s !== landlord);
    const spring = landlordWins && farmers.every((s) => this.playCounts[s] === 0);
    const antiSpring = !landlordWins && this.playCounts[landlord] === 1;
    const multiplier = 2 ** this.bombs * (spring || antiSpring ? 2 : 1);
    const unit = this.highBid * multiplier;
    const scores: [number, number, number, number] = [0, 0, 0, 0];
    for (const s of farmers) scores[s] = landlordWins ? -unit : unit;
    scores[landlord] = landlordWins ? 3 * unit : -3 * unit;
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
