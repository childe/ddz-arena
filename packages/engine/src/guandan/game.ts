import { type Card, sortCards, isValidCard } from '../cards.ts';
import { GameError } from '../game.ts';
import { createRng, shuffle } from '../rng.ts';
import { fullDeck4, containsAll4, removeCards4 } from '../ddz4/cards4.ts';
import { type GdLevel, GD_LEVELS, cardValue, highestCard, isReturnable, isWildcard, sortByValue } from './cards.ts';
import { type GdPattern, type GdHint, resolveGd } from './patterns.ts';
import { type GdMove, legalMovesGd, lowestSingleGd } from './moves.ts';

export type GdSeat = 0 | 1 | 2 | 3;
export type GdTeam = 0 | 1;
export type GdHands = [Card[], Card[], Card[], Card[]];
export type GdPhase = 'return' | 'playing' | 'finished';

export const GD_SEATS: GdSeat[] = [0, 1, 2, 3];
export const GD_HAND_SIZE = 27;
export const teamOf = (s: GdSeat): GdTeam => (s % 2) as GdTeam;
export const partnerOf = (s: GdSeat): GdSeat => ((s + 2) % 4) as GdSeat;
const next = (s: GdSeat): GdSeat => ((s + 1) % 4) as GdSeat;

/**
 * State carried from one hand to the next. `prevOrder` is the finishing order of the previous hand,
 * or null for the first hand of a match (no tribute, random first player).
 */
export interface GuandanMatch {
  /** 1-based hand number within the current match. */
  handNo: number;
  teamLevels: [GdLevel, GdLevel];
  /** The team whose level is played this hand (the last team to go up; team 0 in the first hand). */
  levelTeam: GdTeam;
  /** Hands each team has played at A as the level team without winning the match. */
  aAttempts: [number, number];
  prevOrder: GdSeat[] | null;
}

/** Field names follow the `game.finished` event (section 5 of docs/guandan.md). */
export interface GdResult {
  order: GdSeat[];
  winner_team: GdTeam;
  upgrade: number;
  level: GdLevel;
  team_levels_before: [GdLevel, GdLevel];
  team_levels_after: [GdLevel, GdLevel];
  level_team_next: GdTeam;
  a_attempts: [number, number];
  match_winner: GdTeam | null;
  /** Score delta per seat; always sums to zero. */
  scores: [number, number, number, number];
}

export interface GdTribute {
  from: GdSeat;
  to: GdSeat;
  card: Card;
}
export type GdReturn = GdTribute;

export interface GdPlayRecord {
  seat: GdSeat;
  /** Empty for a pass. */
  cards: Card[];
  pattern: GdPattern | null;
}

export function newMatch(): GuandanMatch {
  return { handNo: 1, teamLevels: ['2', '2'], levelTeam: 0, aAttempts: [0, 0], prevOrder: null };
}

export const matchLevel = (m: GuandanMatch): GdLevel => m.teamLevels[m.levelTeam];

/**
 * Settles a hand from its full finishing order: the first finisher's team goes up 3/2/1 (partner 2nd/
 * 3rd/4th), capped at A. Playing at A as the level team, finishing 1st with the partner not last wins
 * the match and resets both teams to 2. The third failed hand at A sends that team back to 2.
 */
export function settleHand(match: GuandanMatch, order: GdSeat[]): GdResult {
  const before = match.teamLevels;
  const level = matchLevel(match);
  const winnerTeam = teamOf(order[0]!);
  const partnerPlace = order.indexOf(partnerOf(order[0]!));
  const upgrade = 4 - partnerPlace;
  const atA = level === 'A';
  const matchWinner = atA && winnerTeam === match.levelTeam && upgrade >= 2 ? winnerTeam : null;

  let after: [GdLevel, GdLevel] = [...before];
  let attempts: [number, number] = [...match.aAttempts];
  let levelTeamNext: GdTeam = winnerTeam;
  if (matchWinner !== null) {
    after = ['2', '2'];
    attempts = [0, 0];
    levelTeamNext = 0;
  } else {
    after[winnerTeam] = GD_LEVELS[Math.min(GD_LEVELS.length - 1, GD_LEVELS.indexOf(before[winnerTeam]) + upgrade)]!;
    if (atA) {
      // Applied after the upgrade, so a third failure resets even if the level team finished first.
      attempts[match.levelTeam]++;
      if (attempts[match.levelTeam] >= 3) {
        after[match.levelTeam] = '2';
        attempts[match.levelTeam] = 0;
      }
    }
  }
  const unit = upgrade + (matchWinner !== null ? 3 : 0);
  const scores = GD_SEATS.map((s) => (teamOf(s) === winnerTeam ? unit : -unit)) as GdResult['scores'];
  return {
    order: [...order], winner_team: winnerTeam, upgrade, level, team_levels_before: [...before],
    team_levels_after: after, level_team_next: levelTeamNext, a_attempts: attempts, match_winner: matchWinner, scores,
  };
}

/** The match state for the hand after one that ended with `result`. A won match starts over. */
export function nextMatch(match: GuandanMatch, result: GdResult): GuandanMatch {
  if (result.match_winner !== null) return newMatch();
  return {
    handNo: match.handNo + 1,
    teamLevels: [...result.team_levels_after],
    levelTeam: result.level_team_next,
    aAttempts: [...result.a_attempts],
    prevOrder: [...result.order],
  };
}

const countRJ = (cards: Card[]) => cards.filter((c) => c === 'RJ').length;

/**
 * One hand of Guandan: deal 27 each, automatic tribute (or anti-tribute), returns, then play until one
 * team is out or three players are. Seats 0/2 and 1/3 are partners.
 */
export class GuandanGame {
  readonly seed: string;
  readonly match: GuandanMatch;
  readonly level: GdLevel;
  /** Dealt hands before any tribute. */
  readonly initialHands: GdHands;
  hands: GdHands;
  phase: GdPhase;
  turn: GdSeat;
  /** False for the first hand of a match, which has no tribute step at all. */
  readonly hasTribute: boolean;
  /** True when the tribute was refused with two big jokers (抗贡). */
  readonly anti: boolean;
  /** Tributes paid, the one to the first finisher first; already moved into the receivers' hands. */
  readonly tributes: GdTribute[] = [];
  /** Returns made so far: `from` is the receiver giving a card back to the tribute payer `to`. */
  returns: GdReturn[] = [];
  /** Seat that leads the first trick. */
  readonly firstLeader: GdSeat;
  /** The play currently to beat, or null when the seat on turn leads freely. */
  lastPlay: GdPlayRecord | null = null;
  history: GdPlayRecord[] = [];
  /** Seats that have played out, in order. */
  order: GdSeat[] = [];
  result: GdResult | null = null;
  /** Seats that passed since `lastPlay`. */
  private passed = new Set<GdSeat>();

  /** `deal` replaces the shuffled deal (tests and replays); the seed still decides the first-hand leader. */
  constructor(seed: string, match: GuandanMatch, deal?: GdHands) {
    this.seed = seed;
    this.match = match;
    this.level = matchLevel(match);
    const rng = createRng(seed);
    const deck = shuffle(fullDeck4(), rng);
    const dealt = deal ?? (GD_SEATS.map((s) => deck.slice(s * GD_HAND_SIZE, (s + 1) * GD_HAND_SIZE)) as GdHands);
    this.hands = dealt.map((h) => sortCards(h)) as GdHands;
    this.initialHands = this.hands.map((h) => [...h]) as GdHands;
    const randomSeat = Math.floor(rng() * 4) as GdSeat;

    const prev = match.prevOrder;
    this.hasTribute = prev !== null;
    if (!prev) {
      this.anti = false;
      this.firstLeader = randomSeat;
      this.phase = 'playing';
      this.turn = randomSeat;
      return;
    }
    const [first, second, third, last] = prev as [GdSeat, GdSeat, GdSeat, GdSeat];
    const double = teamOf(third) === teamOf(last);
    const payers = double ? [third, last] : [last];
    this.anti = payers.reduce<number>((n, s) => n + countRJ(this.hands[s]), 0) >= 2;
    if (this.anti) {
      this.firstLeader = first;
      this.phase = 'playing';
      this.turn = first;
      return;
    }
    const paid = payers.map((s) => ({ from: s, card: highestCard(this.hands[s], this.level)! }));
    if (double) {
      // Bigger tribute to the first finisher; on a tie, the payer met first going round from the first finisher.
      const dist = (s: GdSeat) => (s - first + 4) % 4;
      paid.sort((a, b) => cardValue(b.card, this.level) - cardValue(a.card, this.level) || dist(a.from) - dist(b.from));
    }
    const receivers = [first, second];
    paid.forEach((p, i) => this.tributes.push({ from: p.from, to: receivers[i]!, card: p.card }));
    for (const t of this.tributes) {
      this.hands[t.from] = removeCards4(this.hands[t.from], [t.card]);
      this.hands[t.to] = sortCards([...this.hands[t.to], t.card]);
    }
    this.firstLeader = this.tributes[0]!.from;
    this.phase = 'return';
    this.turn = this.tributes[0]!.to;
  }

  get handNo(): number {
    return this.match.handNo;
  }

  get levelTeam(): GdTeam {
    return this.match.levelTeam;
  }

  /** `{anti, tributes}` as in the `tribute` event, or null for the first hand of a match. */
  get tribute(): { anti: boolean; tributes: GdTribute[] } | null {
    return this.hasTribute ? { anti: this.anti, tributes: this.tributes } : null;
  }

  get cardsLeft(): [number, number, number, number] {
    return this.hands.map((h) => h.length) as [number, number, number, number];
  }

  /** The pattern the seat on turn must beat, or null if it leads. */
  get toBeat(): GdPattern | null {
    return this.lastPlay?.pattern ?? null;
  }

  get canPass(): boolean {
    return this.phase === 'playing' && this.toBeat !== null;
  }

  /** Returns still owed, in the order they must be made. */
  get pendingReturns(): { from: GdSeat; to: GdSeat }[] {
    return this.tributes.slice(this.returns.length).map((t) => ({ from: t.to, to: t.from }));
  }

  private expect(phase: GdPhase, seat: GdSeat) {
    if (this.phase !== phase) throw new GameError('WRONG_PHASE', `game is in ${this.phase} phase`);
    if (this.turn !== seat) throw new GameError('NOT_YOUR_TURN', `it is seat ${this.turn}'s turn`);
  }

  /**
   * Distinct cards `seat` may return: natural 2–10, no joker, no wildcard. If the hand has none of those,
   * any card except the wildcard.
   */
  returnableCards(seat: GdSeat): Card[] {
    const hand = this.hands[seat];
    let ok = hand.filter((c) => isReturnable(c, this.level));
    if (ok.length === 0) ok = hand.filter((c) => !isWildcard(c, this.level));
    return sortByValue([...new Set(ok)], this.level);
  }

  /** Gives one card back to the tribute payer. Receivers return in order: first finisher, then second. */
  returnCard(seat: GdSeat, card: Card): GdReturn {
    this.expect('return', seat);
    if (!isValidCard(card)) throw new GameError('UNKNOWN_CARD', `unknown card code: ${card}`, { cards: [card] });
    if (!containsAll4(this.hands[seat], [card])) throw new GameError('CARDS_NOT_IN_HAND', `${card} is not in your hand`, { cards: [card] });
    if (!this.returnableCards(seat).includes(card)) {
      throw new GameError('BAD_RETURN', 'return a natural 2–10 card (not a joker or the wildcard)', { card });
    }
    const owed = this.pendingReturns[0]!;
    const rec: GdReturn = { from: seat, to: owed.to, card };
    this.hands[seat] = removeCards4(this.hands[seat], [card]);
    this.hands[owed.to] = sortCards([...this.hands[owed.to], card]);
    this.returns.push(rec);
    const more = this.pendingReturns[0];
    if (more) {
      this.turn = more.from;
    } else {
      this.phase = 'playing';
      this.turn = this.firstLeader;
    }
    return rec;
  }

  private active(s: GdSeat): boolean {
    return this.hands[s].length > 0;
  }

  private nextActive(s: GdSeat): GdSeat {
    let n = next(s);
    while (!this.active(n)) n = next(n);
    return n;
  }

  /** Play cards; an empty array passes. Returns the resolved pattern (null for pass). */
  play(seat: GdSeat, cards: Card[], hint?: GdHint): GdPattern | null {
    this.expect('playing', seat);
    const bad = cards.filter((c) => !isValidCard(c));
    if (bad.length) throw new GameError('UNKNOWN_CARD', `unknown card code(s): ${bad.join(', ')}`, { cards: bad });
    const toBeat = this.toBeat;
    if (cards.length === 0) {
      if (!toBeat) throw new GameError('MUST_PLAY', 'you lead this round and cannot pass');
      this.history.push({ seat, cards: [], pattern: null });
      this.passed.add(seat);
      const leader = this.lastPlay!.seat;
      const waiting = GD_SEATS.filter((s) => s !== leader && this.active(s) && !this.passed.has(s));
      if (waiting.length === 0) this.endTrick(leader);
      else this.turn = this.nextActive(seat);
      return null;
    }
    if (!containsAll4(this.hands[seat], cards)) {
      throw new GameError('CARDS_NOT_IN_HAND', 'some cards are not in your hand (or not enough copies)', { cards });
    }
    const r = resolveGd(cards, toBeat, this.level, hint);
    if (!r.ok) throw new GameError(r.code, r.message, { last: this.lastPlay });
    const rec: GdPlayRecord = { seat, cards: sortCards(cards), pattern: r.pattern };
    this.hands[seat] = removeCards4(this.hands[seat], cards);
    this.history.push(rec);
    this.lastPlay = rec;
    this.passed.clear();
    if (this.hands[seat].length === 0) {
      this.order.push(seat);
      if (this.order.length === 3 || this.order.includes(partnerOf(seat))) {
        this.finish();
        return r.pattern;
      }
    }
    this.turn = this.nextActive(seat);
    return r.pattern;
  }

  /** Everyone else passed: the last player leads again, or if out, the partner takes over (接风). */
  private endTrick(leader: GdSeat) {
    this.lastPlay = null;
    this.passed.clear();
    if (this.active(leader)) this.turn = leader;
    else if (this.active(partnerOf(leader))) this.turn = partnerOf(leader);
    else this.turn = this.nextActive(leader);
  }

  private finish() {
    // Seats still holding cards rank after the finishers, in seat order from the last finisher's next seat.
    const lastOut = this.order.at(-1)!;
    for (let s = next(lastOut); s !== lastOut; s = next(s)) if (!this.order.includes(s)) this.order.push(s);
    this.phase = 'finished';
    this.result = settleHand(this.match, this.order);
  }

  /** Every distinct legal play for the seat on turn (empty outside the playing phase). */
  legalMoves(): GdMove[] {
    return this.phase === 'playing' ? legalMovesGd(this.hands[this.turn], this.toBeat, this.level) : [];
  }

  /**
   * Action taken for a seat that timed out: return the lowest returnable card; pass when possible;
   * otherwise lead the lowest single (not the wildcard unless it is all that is left).
   */
  autoAction(): { kind: 'return'; card: Card } | { kind: 'play'; cards: Card[] } {
    if (this.phase === 'return') return { kind: 'return', card: this.returnableCards(this.turn)[0]! };
    if (this.phase === 'playing') return { kind: 'play', cards: this.toBeat ? [] : lowestSingleGd(this.hands[this.turn], this.level) };
    throw new GameError('WRONG_PHASE', 'game is finished');
  }
}
