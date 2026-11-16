// No-Limit Texas Hold'em, one hand per instance.
// Seats are arbitrary ascending integers (the server's room seats); clockwise = ascending, wrapping.
import { GameError } from '../game.ts';
import { createRng, shuffle } from '../rng.ts';
import type { Card } from '../cards.ts';
import { holdemDeck } from './cards.ts';
import { type HoldemHandRank, evaluateHoldem } from './evaluator.ts';

export type HoldemPhase = 'preflop' | 'flop' | 'turn' | 'river' | 'finished';
export type HoldemStreet = 'preflop' | 'flop' | 'turn' | 'river';
export type HoldemActionType = 'fold' | 'check' | 'call' | 'raise';

export interface HoldemOptions {
  seats: number[];
  button: number;
  smallBlind?: number;
  bigBlind?: number;
  stack?: number;
  /** Per-seat starting stacks overriding `stack` (the platform always uses equal stacks; side pots are still handled). */
  stacks?: Record<number, number>;
  /**
   * Explicit deck order (52 distinct cards) instead of the seeded shuffle, for tests and replays.
   * Hole cards are dealt one at a time clockwise from the seat left of the button (two rounds),
   * then the next 5 cards are the board.
   */
  deck?: Card[];
}

export interface HoldemLegalActions {
  fold: boolean;
  check: boolean;
  /** Chips to add to call, or null when there is nothing to call. */
  call: number | null;
  /** Raise-to totals for this street (max = all-in), or null when raising is not allowed. */
  raise: { min: number; max: number } | null;
}

export interface HoldemActionRecord {
  seat: number;
  phase: HoldemStreet;
  /** Blind posts are recorded as 'small_blind' / 'big_blind'. */
  action: HoldemActionType | 'small_blind' | 'big_blind';
  /** raise: raise-to total for the street; call / blinds: chips added; fold / check: 0. */
  amount: number;
  all_in: boolean;
}

export interface HoldemStep {
  action: HoldemActionRecord;
  /** Newly dealt board cards, in order (several streets when nobody can bet any more). */
  streets: { phase: 'flop' | 'turn' | 'river'; cards: Card[] }[];
  finished: boolean;
}

export interface HoldemShowdownEntry {
  seat: number;
  hole: [Card, Card];
  best: Card[];
  rank: HoldemHandRank;
  score: number;
}

export interface HoldemResult {
  /** Seats that won chips from the pot (refunds of uncalled chips do not count). */
  winners: number[];
  /** Net chips per seat for the hand; sums to 0. */
  scores: Record<number, number>;
  /** Chips each seat took from the pot (including any uncalled refund). */
  payouts: Record<number, number>;
  /** Non-folded hands in seat order, or null when the hand was won by folds. */
  showdown: HoldemShowdownEntry[] | null;
  pot: number;
}

export class HoldemGame {
  readonly seed: string;
  readonly seats: number[];
  readonly button: number;
  readonly smallBlindSeat: number;
  readonly bigBlindSeat: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly startingStacks: Record<number, number>;

  phase: HoldemPhase = 'preflop';
  turn: number | null = null;
  holes: Record<number, [Card, Card]> = {};
  board: Card[] = [];
  stacks: Record<number, number> = {};
  bets: Record<number, number> = {};
  committed: Record<number, number> = {};
  folded: Record<number, boolean> = {};
  allIn: Record<number, boolean> = {};
  pot = 0;
  currentBet = 0;
  /** Size of the last full bet/raise this street (initially the big blind). */
  lastRaiseSize: number;
  minRaiseTo: number;
  history: HoldemActionRecord[] = [];
  result: HoldemResult | null = null;

  /** Remaining 5 board cards, revealed street by street. */
  private readonly runout: Card[];
  /** Seats that still have to act this street. */
  private pending = new Set<number>();
  /** Per seat: currentBet at the moment of its last voluntary action this street, or null if it has not acted. */
  private facedBet: Record<number, number | null> = {};

  constructor(seed: string, opts: HoldemOptions) {
    const seats = [...opts.seats];
    if (seats.length < 2 || seats.length > 6) throw new RangeError('holdem needs 2 to 6 seats');
    if (seats.some((s) => !Number.isInteger(s))) throw new RangeError('seats must be integers');
    seats.sort((a, b) => a - b);
    if (new Set(seats).size !== seats.length) throw new RangeError('duplicate seats');
    if (!seats.includes(opts.button)) throw new RangeError('button must be one of the seats');
    const sb = opts.smallBlind ?? 1;
    const bb = opts.bigBlind ?? 2;
    const stack = opts.stack ?? 200;
    const startStacks: Record<number, number> = {};
    for (const s of seats) startStacks[s] = opts.stacks?.[s] ?? stack;
    const okInt = (x: number) => Number.isInteger(x) && x > 0;
    if (!okInt(bb) || !(Number.isInteger(sb) && sb >= 0) || !seats.every((s) => okInt(startStacks[s]!))) {
      throw new RangeError('blinds and stacks must be positive integers');
    }
    this.seed = seed;
    this.seats = seats;
    this.button = opts.button;
    this.smallBlind = sb;
    this.bigBlind = bb;
    this.startingStacks = startStacks;
    this.lastRaiseSize = bb;
    this.minRaiseTo = bb;

    if (seats.length === 2) {
      this.smallBlindSeat = this.button;
      this.bigBlindSeat = this.next(this.button);
    } else {
      this.smallBlindSeat = this.next(this.button);
      this.bigBlindSeat = this.next(this.smallBlindSeat);
    }

    let deck: Card[];
    if (opts.deck) {
      const valid = new Set(holdemDeck());
      if (opts.deck.length !== 52 || new Set(opts.deck).size !== 52 || opts.deck.some((c) => !valid.has(c))) {
        throw new RangeError('deck must contain all 52 cards exactly once');
      }
      deck = [...opts.deck];
    } else deck = shuffle(holdemDeck(), createRng(seed));
    const order = this.orderFrom(this.next(this.button));
    let k = 0;
    const firstCards: Record<number, Card> = {};
    for (const s of order) firstCards[s] = deck[k++]!;
    for (const s of order) this.holes[s] = [firstCards[s]!, deck[k++]!];
    this.runout = deck.slice(k, k + 5);

    for (const s of seats) {
      this.stacks[s] = startStacks[s]!;
      this.bets[s] = 0;
      this.committed[s] = 0;
      this.folded[s] = false;
      this.allIn[s] = false;
      this.facedBet[s] = null;
    }

    this.post(this.smallBlindSeat, sb, 'small_blind');
    this.post(this.bigBlindSeat, bb, 'big_blind');
    this.currentBet = Math.max(this.bets[this.smallBlindSeat]!, this.bets[this.bigBlindSeat]!);
    this.minRaiseTo = this.currentBet + this.lastRaiseSize;
    for (const s of seats) if (!this.allIn[s]) this.pending.add(s);
    // Edge case (tiny custom stacks): blinds may already put players all-in.
    this.afterAction(this.bigBlindSeat, []);
  }

  // ---------------------------------------------------------------- queries

  /** Next seat clockwise (any status). */
  next(seat: number): number {
    const i = this.seats.indexOf(seat);
    return this.seats[(i + 1) % this.seats.length]!;
  }

  /** All seats starting at `start`, clockwise. */
  private orderFrom(start: number): number[] {
    const i = this.seats.indexOf(start);
    return [...this.seats.slice(i), ...this.seats.slice(0, i)];
  }

  private canAct(s: number): boolean {
    return !this.folded[s] && !this.allIn[s];
  }

  /** Chips needed to call (capped at the stack). */
  toCall(seat: number): number {
    return Math.min(this.currentBet - (this.bets[seat] ?? 0), this.stacks[seat] ?? 0);
  }

  legalActions(seat: number): HoldemLegalActions {
    if (this.phase === 'finished' || seat !== this.turn) return { fold: false, check: false, call: null, raise: null };
    const owe = this.currentBet - this.bets[seat]!;
    const max = this.bets[seat]! + this.stacks[seat]!;
    let raise: HoldemLegalActions['raise'] = null;
    const faced = this.facedBet[seat];
    // A player who already acted may re-raise only if the bet has since grown by a full raise.
    const reopened = faced == null || this.currentBet - faced >= this.lastRaiseSize;
    const opponentsWithChips = this.seats.some((s) => s !== seat && this.canAct(s));
    if (max > this.currentBet && reopened && opponentsWithChips) {
      raise = { min: Math.min(this.minRaiseTo, max), max };
    }
    return {
      fold: true,
      check: owe === 0,
      call: owe > 0 ? Math.min(owe, this.stacks[seat]!) : null,
      raise,
    };
  }

  autoAction(): { action: 'check' } | { action: 'fold' } {
    if (this.turn !== null && this.legalActions(this.turn).check) return { action: 'check' };
    return { action: 'fold' };
  }

  // ---------------------------------------------------------------- actions

  act(seat: number, action: HoldemActionType, amount?: number): HoldemStep {
    if (this.phase === 'finished') throw new GameError('WRONG_PHASE', 'hand is finished');
    if (seat !== this.turn) throw new GameError('NOT_YOUR_TURN', `it is seat ${this.turn}'s turn`);
    const legal = this.legalActions(seat);
    const street = this.phase as HoldemStreet;
    let rec: HoldemActionRecord;
    switch (action) {
      case 'fold':
        this.folded[seat] = true;
        rec = { seat, phase: street, action, amount: 0, all_in: false };
        break;
      case 'check':
        if (!legal.check) throw new GameError('CANNOT_CHECK', `you must call ${legal.call} or fold`, { call: legal.call });
        rec = { seat, phase: street, action, amount: 0, all_in: false };
        break;
      case 'call': {
        if (legal.call === null) throw new GameError('BAD_ACTION', 'nothing to call; check instead');
        const added = legal.call;
        this.put(seat, added);
        rec = { seat, phase: street, action, amount: added, all_in: this.allIn[seat]! };
        break;
      }
      case 'raise': {
        if (!legal.raise) throw new GameError('BAD_ACTION', 'raising is not allowed now', { legal });
        const { min, max } = legal.raise;
        if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < min || amount > max) {
          throw new GameError('BAD_AMOUNT', `raise-to amount must be an integer between ${min} and ${max}`, { min, max });
        }
        const increase = amount - this.currentBet;
        if (increase >= this.lastRaiseSize) {
          this.lastRaiseSize = increase;
        }
        this.put(seat, amount - this.bets[seat]!);
        this.currentBet = amount;
        this.minRaiseTo = amount + this.lastRaiseSize;
        // Everybody else who can still act must respond to the new bet.
        this.pending.clear();
        for (const s of this.seats) if (s !== seat && this.canAct(s)) this.pending.add(s);
        rec = { seat, phase: street, action, amount, all_in: this.allIn[seat]! };
        break;
      }
      default:
        throw new GameError('BAD_ACTION', `unknown action ${String(action)}`);
    }
    this.facedBet[seat] = this.currentBet;
    this.pending.delete(seat);
    this.history.push(rec);
    const streets: HoldemStep['streets'] = [];
    this.afterAction(seat, streets);
    return { action: rec, streets, finished: this.result !== null };
  }

  private post(seat: number, blind: number, kind: 'small_blind' | 'big_blind'): void {
    const added = Math.min(blind, this.stacks[seat]!);
    this.put(seat, added);
    this.history.push({ seat, phase: 'preflop', action: kind, amount: added, all_in: this.allIn[seat]! });
  }

  private put(seat: number, chips: number): void {
    this.stacks[seat]! -= chips;
    this.bets[seat]! += chips;
    this.committed[seat]! += chips;
    this.pot += chips;
    if (this.stacks[seat] === 0) this.allIn[seat] = true;
  }

  /** Advance turn / streets / showdown after `seat` acted. */
  private afterAction(seat: number, streets: HoldemStep['streets']): void {
    const live = this.seats.filter((s) => !this.folded[s]);
    if (live.length === 1) {
      this.finish(null);
      return;
    }
    // Players all-in can no longer act.
    for (const s of [...this.pending]) if (!this.canAct(s)) this.pending.delete(s);
    if (this.pending.size > 0) {
      this.turn = this.orderFrom(this.next(seat)).find((s) => this.pending.has(s))!;
      return;
    }
    // Betting round over: deal streets until someone can bet or the hand reaches showdown.
    for (;;) {
      if (this.phase === 'river') {
        this.showdown();
        return;
      }
      this.startStreet(streets);
      const actors = this.seats.filter((s) => this.canAct(s));
      if (actors.length >= 2) {
        for (const s of actors) this.pending.add(s);
        this.turn = this.orderFrom(this.next(this.button)).find((s) => this.pending.has(s))!;
        return;
      }
    }
  }

  private startStreet(streets: HoldemStep['streets']): void {
    const nextPhase = this.phase === 'preflop' ? 'flop' : this.phase === 'flop' ? 'turn' : 'river';
    const cards = nextPhase === 'flop' ? this.runout.slice(0, 3) : nextPhase === 'turn' ? [this.runout[3]!] : [this.runout[4]!];
    this.phase = nextPhase;
    this.board.push(...cards);
    streets.push({ phase: nextPhase, cards });
    for (const s of this.seats) {
      this.bets[s] = 0;
      this.facedBet[s] = null;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.minRaiseTo = this.bigBlind;
    this.pending.clear();
  }

  private showdown(): void {
    const entries: HoldemShowdownEntry[] = this.seats
      .filter((s) => !this.folded[s])
      .map((s) => {
        const v = evaluateHoldem([...this.holes[s]!, ...this.board]);
        return { seat: s, hole: this.holes[s]!, best: v.best, rank: v.rank, score: v.score };
      });
    this.finish(entries);
  }

  private finish(showdown: HoldemShowdownEntry[] | null): void {
    const scoreOf = new Map<number, number>();
    for (const e of showdown ?? []) scoreOf.set(e.seat, e.score);
    const payouts: Record<number, number> = {};
    for (const s of this.seats) payouts[s] = 0;
    const winners = new Set<number>();
    const leftOfButton = this.orderFrom(this.next(this.button));

    // Split the pot into layers by commitment level. Consecutive layers with the same eligible
    // players are merged, so with equal stacks there is exactly one pot (one odd-chip split).
    const pots: { amount: number; eligible: number[] }[] = [];
    const levels = [...new Set(this.seats.map((s) => this.committed[s]!))].filter((l) => l > 0).sort((a, b) => a - b);
    let prev = 0;
    for (const level of levels) {
      const contributors = this.seats.filter((s) => this.committed[s]! >= level);
      const amount = (level - prev) * contributors.length;
      prev = level;
      const eligible = contributors.filter((s) => !this.folded[s]);
      const last = pots.at(-1);
      if (contributors.length === 1) {
        // Uncalled chips go back to their owner; that is a refund, not a win.
        payouts[contributors[0]!]! += amount;
      } else if (last && (eligible.length === 0 || last.eligible.join() === eligible.join())) {
        // Same contenders (or only folded contributors left): add to the pot below.
        last.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
    for (const pot of pots) {
      let potWinners: number[];
      if (showdown === null || pot.eligible.length === 1) potWinners = pot.eligible;
      else {
        const top = Math.max(...pot.eligible.map((s) => scoreOf.get(s)!));
        potWinners = pot.eligible.filter((s) => scoreOf.get(s) === top);
      }
      // Odd chips go to the first winner(s) clockwise from the button.
      potWinners = leftOfButton.filter((s) => potWinners.includes(s));
      const share = Math.floor(pot.amount / potWinners.length);
      let odd = pot.amount - share * potWinners.length;
      for (const s of potWinners) {
        payouts[s]! += share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        winners.add(s);
      }
    }

    const scores: Record<number, number> = {};
    for (const s of this.seats) {
      scores[s] = payouts[s]! - this.committed[s]!;
      this.stacks[s]! += payouts[s]!;
    }
    this.result = {
      winners: this.seats.filter((s) => winners.has(s)),
      scores,
      payouts,
      showdown,
      pot: this.pot,
    };
    this.phase = 'finished';
    this.turn = null;
    this.pending.clear();
  }
}
