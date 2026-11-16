// No-Limit Texas Hold'em adapter. Every hand starts with fresh 200-chip stacks and 1/2 blinds; per-seat
// arrays in events and views are indexed by room seat, with null for seats not in the hand.
import { GameError, HoldemGame, type HoldemActionType, type HoldemStep } from '@ddz/engine';
import { badRequest } from '../errors.ts';
import { timeoutMs } from './ddz.ts';
import type { ActResult, Emit, GameSession, GameVariant, PlayerOutcome } from './types.ts';

const SMALL_BLIND = 1;
const BIG_BLIND = 2;
const STACK = 200;
const ACTIONS: HoldemActionType[] = ['fold', 'check', 'call', 'raise'];

class HoldemSession implements GameSession {
  readonly seats: number[];
  private g: HoldemGame;
  private n: number;

  constructor(seed: string, seats: number[], seatCount: number, prev: HoldemSession | null) {
    this.seats = seats;
    this.n = seatCount;
    this.g = new HoldemGame(seed, { seats, button: nextButton(seats, prev?.g.button ?? null), smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, stack: STACK });
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
    return false;
  }

  /** Per-seat array of a Record keyed by seat. */
  private bySeat<T>(rec: Record<number, T>): (T | null)[] {
    return Array.from({ length: this.n }, (_, i) => (this.seats.includes(i) ? rec[i]! : null));
  }

  startEvents(): Emit[] {
    const g = this.g;
    const priv: Record<number, Record<string, unknown>> = {};
    for (const s of this.seats) priv[s] = { hole: g.holes[s] };
    return [{
      type: 'game.started',
      data: {
        phase: 'preflop', button: g.button, small_blind_seat: g.smallBlindSeat, big_blind_seat: g.bigBlindSeat,
        small_blind: g.smallBlind, big_blind: g.bigBlind, stacks: this.bySeat(g.stacks), bets: this.bySeat(g.bets), pot: g.pot,
      },
      priv,
    }];
  }

  private legal(seat: number) {
    const l = this.g.legalActions(seat);
    return {
      phase: this.g.phase, to_call: l.call ?? 0, can_check: l.check,
      min_raise_to: l.raise?.min ?? null, max_raise_to: l.raise?.max ?? null,
      current_bet: this.g.currentBet, pot: this.g.pot,
    };
  }

  turnEvent(): Emit {
    const seat = this.g.turn!;
    return { type: 'turn', data: { seat, ...this.legal(seat) } };
  }

  turnTimeout(config: Record<string, unknown>) {
    return config.action_timeout_ms as number;
  }

  act(seat: number, op: string, body: Record<string, unknown>): ActResult {
    if (op !== 'action') throw badRequest(`this game uses action, not ${op}`);
    const action = body.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action as HoldemActionType)) {
      throw new GameError('BAD_ACTION', 'action must be fold, check, call or raise');
    }
    if (action === 'raise' && typeof body.amount !== 'number') throw new GameError('BAD_AMOUNT', 'raise needs amount: the total bet for this street');
    const before = this.g.bets[seat] ?? 0;
    return { events: this.step(this.g.act(seat, action as HoldemActionType, body.amount as number | undefined), before, false) };
  }

  /** `before` is the seat's bet on this street before acting (the engine resets bets when a street closes). */
  private step(step: HoldemStep, before: number, auto: boolean): Emit[] {
    const g = this.g;
    const a = step.action;
    const bet = a.action === 'raise' ? a.amount : a.action === 'call' ? before + a.amount : before;
    const events: Emit[] = [{
      type: 'acted',
      data: { seat: a.seat, phase: a.phase, action: a.action, amount: a.amount, all_in: a.all_in, auto, stack: g.stacks[a.seat], bet, pot: g.pot },
    }];
    for (const s of step.streets) {
      const upTo = s.phase === 'flop' ? 3 : s.phase === 'turn' ? 4 : 5;
      events.push({ type: 'board', data: { phase: s.phase, cards: s.cards, board: g.board.slice(0, upTo) } });
    }
    return events;
  }

  auto(seat: number): Emit[] {
    const a = this.g.autoAction();
    const before = this.g.bets[seat] ?? 0;
    return this.step(this.g.act(seat, a.action), before, true);
  }

  publicView() {
    const g = this.g;
    return {
      phase: g.phase, button: g.button, small_blind_seat: g.smallBlindSeat, big_blind_seat: g.bigBlindSeat,
      small_blind: g.smallBlind, big_blind: g.bigBlind, board: g.board, pot: g.pot,
      current_bet: g.currentBet, min_raise_to: g.minRaiseTo,
      stacks: this.bySeat(g.stacks), bets: this.bySeat(g.bets), committed: this.bySeat(g.committed),
      folded: this.bySeat(g.folded), all_in: this.bySeat(g.allIn),
      history: g.history, result: g.result ? this.resultData() : null,
    };
  }

  privateView(seat: number) {
    return { hole: this.g.holes[seat], ...(this.g.turn === seat && !this.finished ? { legal: this.legal(seat) } : {}) };
  }

  legalMoves(seat: number) {
    if (this.finished || this.g.turn !== seat) return { actions: null };
    return { actions: this.g.legalActions(seat) };
  }

  finishedData() {
    return { result: this.resultData(), seed: this.g.seed };
  }

  resultData() {
    const r = this.g.result!;
    return { winners: r.winners, scores: this.bySeat(r.scores), payouts: this.bySeat(r.payouts), showdown: r.showdown, pot: r.pot };
  }

  outcomes(): PlayerOutcome[] {
    const r = this.g.result!;
    return this.seats.map((seat) => ({ seat, score: r.scores[seat]!, win: r.winners.includes(seat), isLandlord: false }));
  }

  replayData() {
    return { seed: this.g.seed, holes: this.bySeat(this.g.holes) };
  }
}

/** The seat after `prev` clockwise among `seats` (the first seat for the room's first hand). */
function nextButton(seats: number[], prev: number | null): number {
  if (prev === null) return seats[0]!;
  return seats.find((s) => s > prev) ?? seats[0]!;
}

export const holdem: GameVariant = {
  type: 'holdem',
  seatCount: (config) => config.seats as number,
  minPlayers: () => 2,
  defaultConfig: { seats: 6, action_timeout_ms: 15_000 },
  parseConfig(raw) {
    const out: Record<string, unknown> = {};
    if (raw.seats !== undefined) {
      if (typeof raw.seats !== 'number' || !Number.isInteger(raw.seats) || raw.seats < 2 || raw.seats > 6) throw badRequest('seats must be an integer between 2 and 6');
      out.seats = raw.seats;
    }
    if (raw.action_timeout_ms !== undefined) out.action_timeout_ms = timeoutMs(raw.action_timeout_ms, 'action_timeout_ms');
    return out;
  },
  maxRedeals: 0,
  create: (seed, seats, config, prev) => new HoldemSession(seed, seats, config.seats as number, prev instanceof HoldemSession ? prev : null),
};
