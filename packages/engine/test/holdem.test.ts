import { describe, it, expect } from 'vitest';
import { GameError } from '../src/game.ts';
import { createRng } from '../src/rng.ts';
import {
  HoldemGame,
  HOLDEM_HAND_NAMES,
  evaluateHoldem,
  holdemHandScore,
  holdemScoreIndices,
  holdemDeck,
  compareHoldemHands,
  type HoldemActionType,
} from '../src/holdem/index.ts';

function expectError(fn: () => unknown, code: string, status: number) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    expect((e as GameError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

const h = (s: string) => s.split(' ');
const ev = (s: string) => evaluateHoldem(h(s));

/** Build a full deck so that the given seats get the given holes and the board comes next. */
function stackedDeck(seats: number[], button: number, holes: Record<number, string>, board: string): string[] {
  const i = seats.indexOf(button);
  const order = [...seats.slice(i + 1), ...seats.slice(0, i + 1)];
  const top: string[] = [];
  for (const round of [0, 1]) for (const s of order) top.push(h(holes[s]!)[round]!);
  top.push(...h(board));
  const used = new Set(top);
  return [...top, ...holdemDeck().filter((c) => !used.has(c))];
}

// ------------------------------------------------------------------ evaluator

describe('evaluator', () => {
  it('names every category', () => {
    const cases: [string, string][] = [
      ['AS KD 9C 7H 4S 3D 2C', 'high_card'],
      ['AS AD 9C 7H 4S 3D 2C', 'pair'],
      ['AS AD 9C 9H 4S 3D 2C', 'two_pair'],
      ['AS AD AC 9H 4S 3D 2C', 'three_of_a_kind'],
      ['6S 5D 4C 3H 2S KD KC', 'straight'],
      ['AS 2D 3C 4H 5S KD KC', 'straight'],
      ['AS 9S 7S 4S 2S KD KC', 'flush'],
      ['AS AD AC 9H 9S 3D 2C', 'full_house'],
      ['AS AD AC AH 9S 3D 2C', 'four_of_a_kind'],
      ['9H 8H 7H 6H 5H AS AD', 'straight_flush'],
      ['AH 2H 3H 4H 5H KS KD', 'straight_flush'],
    ];
    for (const [cards, rank] of cases) expect(ev(cards).rank, cards).toBe(rank);
    expect(HOLDEM_HAND_NAMES).toHaveLength(9);
  });

  it('orders categories', () => {
    const order = [
      'AS KD 9C 7H 4S 3D 2C',
      'AS AD 9C 7H 4S 3D 2C',
      'AS AD 9C 9H 4S 3D 2C',
      'AS AD AC 9H 4S 3D 2C',
      'AS 2D 3C 4H 5S KD 9C',
      'AS 9S 7S 4S 2S KD KC',
      '2S 2D 2C 3H 3S 8D 9C',
      '2S 2D 2C 2H 3S 8D 9C',
      'AH 2H 3H 4H 5H KS KD',
    ].map((c) => holdemHandScore(h(c)));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]!);
  });

  it('wheel is the lowest straight, broadway the highest', () => {
    const wheel = holdemHandScore(h('AS 2D 3C 4H 5S 9D 9C'));
    const six = holdemHandScore(h('6S 2D 3C 4H 5S 9D 9C'));
    const broadway = holdemHandScore(h('AS KD QC JH TS 2D 2C'));
    expect(six).toBeGreaterThan(wheel);
    expect(broadway).toBeGreaterThan(six);
    expect(ev('AS 2D 3C 4H 5S 9D 9C').best).toEqual(h('5S 4H 3C 2D AS'));
    // A 6-high straight beats the wheel even when both are present
    expect(ev('AS 2D 3C 4H 5S 6D 9C').best).toEqual(h('6D 5S 4H 3C 2D'));
    // K-A-2-3-4 is not a straight
    expect(ev('KS AD 2C 3H 4S 9D 8C').rank).toBe('high_card');
  });

  it('compares kickers', () => {
    expect(compareHoldemHands(h('AS AD KC 7H 4S 3D 2C'), h('AH AC QC 7D 4H 3C 2D'))).toBeGreaterThan(0);
    // two pair: best two pairs out of three, then kicker
    expect(ev('AS AD KC KH 4S 4D 2C').best).toEqual(h('AS AD KH KC 4S'));
    expect(compareHoldemHands(h('AS AD KC KH QS 4D 2C'), h('AH AC KD KS JS 4H 3C'))).toBeGreaterThan(0);
    // trips kickers
    expect(compareHoldemHands(h('7S 7D 7C AH 3S 4D 2C'), h('7H 7S 7D KH QS JD 9C'))).toBeGreaterThan(0);
    // flush compares all five cards
    expect(compareHoldemHands(h('AS QS 9S 7S 3S'), h('AH QH 9H 7H 2H'))).toBeGreaterThan(0);
    // full house: trips first, then pair; two trips -> higher trips + pair of the other
    expect(ev('5S 5D 5C 9H 9S 9D 2C').best).toEqual(h('9S 9H 9D 5S 5D'));
    expect(compareHoldemHands(h('3S 3D 3C AH AS'), h('2S 2D 2C AD AC'))).toBeGreaterThan(0);
    // quads kicker
    expect(compareHoldemHands(h('9S 9D 9C 9H AS 2D 3C'), h('9S 9D 9C 9H KS QD JC'))).toBeGreaterThan(0);
    // high card: only top five count
    expect(compareHoldemHands(h('AS KD 9C 7H 4S 3D 2C'), h('AS KD 9C 7H 4S 3H 2H'))).toBe(0);
  });

  it('board plays: equal hands tie', () => {
    const board = 'AS KS QS JS TS';
    expect(compareHoldemHands(h(`${board} 2H 3D`), h(`${board} 9H 8D`))).toBe(0);
    expect(ev(`${board} 2H 3D`).best).toEqual(h('AS KS QS JS TS'));
    // straight on board, nobody improves
    expect(compareHoldemHands(h('9S 8D 7C 6H 5S 2H 2D'), h('9S 8D 7C 6H 5S AH KD'))).toBe(0);
    // board two pair + higher kicker in hand wins
    expect(compareHoldemHands(h('AS AD KC KH 4S QH 2D'), h('AS AD KC KH 4S JH 2D'))).toBeGreaterThan(0);
  });

  it('rejects bad input', () => {
    expect(() => holdemHandScore(h('AS AS KD QC JH'))).toThrow();
    expect(() => holdemHandScore(h('AS KD QC JH'))).toThrow();
    expect(() => holdemHandScore(h('AS KD QC JH 1H'))).toThrow();
  });

  it('is fast (>= 100k 7-card evaluations per second)', () => {
    const rng = createRng('bench');
    const N = 200_000;
    const hands = new Int32Array(N * 7);
    const idx = Array.from({ length: 52 }, (_, i) => i);
    for (let n = 0; n < N; n++) {
      for (let k = 0; k < 7; k++) {
        const j = k + Math.floor(rng() * (52 - k));
        [idx[k], idx[j]] = [idx[j]!, idx[k]!];
        hands[n * 7 + k] = idx[k]!;
      }
    }
    let sink = 0;
    const t0 = performance.now();
    for (let n = 0; n < N; n++) sink ^= holdemScoreIndices(hands.subarray(n * 7, n * 7 + 7));
    const t1 = performance.now();
    const deck = holdemDeck();
    const strHands = Array.from({ length: 50_000 }, (_, n) =>
      Array.from(hands.subarray(n * 7, n * 7 + 7), (i) => deck[i]!),
    );
    const t2 = performance.now();
    for (const cards of strHands) sink ^= holdemHandScore(cards);
    const t3 = performance.now();
    const idxRate = Math.round(N / ((t1 - t0) / 1000));
    const strRate = Math.round(strHands.length / ((t3 - t2) / 1000));
    console.log(`holdem evaluator: ${idxRate} evals/s (indices), ${strRate} evals/s (card strings) [${sink & 1}]`);
    expect(strRate).toBeGreaterThan(100_000);
  });
});

// ------------------------------------------------------------------ game

describe('blinds and action order', () => {
  it('heads-up: button posts SB and acts first preflop, BB acts first postflop', () => {
    const g = new HoldemGame('hu', { seats: [3, 1], button: 3 });
    expect(g.seats).toEqual([1, 3]);
    expect(g.smallBlindSeat).toBe(3);
    expect(g.bigBlindSeat).toBe(1);
    expect(g.bets).toEqual({ 1: 2, 3: 1 });
    expect(g.stacks).toEqual({ 1: 198, 3: 199 });
    expect(g.pot).toBe(3);
    expect(g.turn).toBe(3);
    expect(g.legalActions(3)).toEqual({ fold: true, check: false, call: 1, raise: { min: 4, max: 200 } });
    expect(g.legalActions(1)).toEqual({ fold: false, check: false, call: null, raise: null });
    g.act(3, 'call');
    // BB option
    expect(g.phase).toBe('preflop');
    expect(g.turn).toBe(1);
    expect(g.legalActions(1)).toEqual({ fold: true, check: true, call: null, raise: { min: 4, max: 200 } });
    const step = g.act(1, 'check');
    expect(step.streets).toEqual([{ phase: 'flop', cards: g.board }]);
    expect(g.board).toHaveLength(3);
    expect(g.turn).toBe(1);
    expect(g.minRaiseTo).toBe(2);
    g.act(1, 'check');
    expect(g.turn).toBe(3);
    g.act(3, 'check');
    expect(g.phase).toBe('turn');
    expect(g.turn).toBe(1);
  });

  it('3 players: SB/BB left of button, button acts first preflop, SB first postflop', () => {
    const g = new HoldemGame('three', { seats: [0, 2, 5], button: 2 });
    expect(g.smallBlindSeat).toBe(5);
    expect(g.bigBlindSeat).toBe(0);
    expect(g.turn).toBe(2);
    g.act(2, 'call');
    expect(g.turn).toBe(5);
    g.act(5, 'call');
    expect(g.turn).toBe(0);
    g.act(0, 'check');
    expect(g.phase).toBe('flop');
    expect(g.turn).toBe(5);
    g.act(5, 'check');
    g.act(0, 'check');
    expect(g.turn).toBe(2);
    g.act(2, 'check');
    expect(g.phase).toBe('turn');
    expect(g.turn).toBe(5);
  });

  it('6 players: UTG acts first; button wraps', () => {
    const seats = [0, 1, 2, 3, 4, 5];
    const g = new HoldemGame('six', { seats, button: 4 });
    expect(g.smallBlindSeat).toBe(5);
    expect(g.bigBlindSeat).toBe(0);
    expect(g.turn).toBe(1);
    expect(g.history.slice(0, 2)).toEqual([
      { seat: 5, phase: 'preflop', action: 'small_blind', amount: 1, all_in: false },
      { seat: 0, phase: 'preflop', action: 'big_blind', amount: 2, all_in: false },
    ]);
    const order: number[] = [];
    while (g.phase === 'preflop') {
      order.push(g.turn!);
      g.act(g.turn!, g.legalActions(g.turn!).check ? 'check' : 'call');
    }
    expect(order).toEqual([1, 2, 3, 4, 5, 0]);
    expect(g.turn).toBe(5); // first active left of button
    // all hole cards distinct
    expect(new Set([...Object.values(g.holes).flat(), ...g.board]).size).toBe(12 + 3);
  });

  it('postflop skips folded players', () => {
    const g = new HoldemGame('skip', { seats: [0, 1, 2, 3], button: 0 });
    // SB=1, BB=2, UTG=3
    g.act(3, 'call');
    g.act(0, 'call');
    g.act(1, 'fold');
    g.act(2, 'check');
    expect(g.phase).toBe('flop');
    expect(g.turn).toBe(2);
  });

  it('validates turn, phase, check and amounts', () => {
    const g = new HoldemGame('v', { seats: [0, 1, 2], button: 0 });
    expect(g.turn).toBe(0);
    expectError(() => g.act(1, 'fold'), 'NOT_YOUR_TURN', 409);
    expectError(() => g.act(0, 'check'), 'CANNOT_CHECK', 422);
    expectError(() => g.act(0, 'raise', 3), 'BAD_AMOUNT', 422);
    expectError(() => g.act(0, 'raise', 201), 'BAD_AMOUNT', 422);
    expectError(() => g.act(0, 'raise'), 'BAD_AMOUNT', 422);
    expectError(() => g.act(0, 'raise', 4.5), 'BAD_AMOUNT', 422);
    expectError(() => g.act(0, 'shove' as HoldemActionType), 'BAD_ACTION', 400);
    g.act(0, 'call');
    g.act(1, 'call');
    expectError(() => g.act(2, 'call'), 'BAD_ACTION', 400);
    expect(g.autoAction()).toEqual({ action: 'check' });
    g.act(2, 'raise', 10);
    expect(g.autoAction()).toEqual({ action: 'fold' });
    g.act(0, 'fold');
    g.act(1, 'fold');
    expect(g.phase).toBe('finished');
    expectError(() => g.act(2, 'check'), 'WRONG_PHASE', 409);
  });

  it('rejects bad options', () => {
    expect(() => new HoldemGame('x', { seats: [0], button: 0 })).toThrow();
    expect(() => new HoldemGame('x', { seats: [0, 1, 2, 3, 4, 5, 6], button: 0 })).toThrow();
    expect(() => new HoldemGame('x', { seats: [0, 1], button: 2 })).toThrow();
  });
});

describe('raising', () => {
  it('min-raise tracks the last raise size', () => {
    const g = new HoldemGame('mr', { seats: [0, 1, 2], button: 0 });
    expect(g.minRaiseTo).toBe(4);
    g.act(0, 'raise', 7); // raise by 5
    expect(g.currentBet).toBe(7);
    expect(g.minRaiseTo).toBe(12);
    expect(g.legalActions(1).raise).toEqual({ min: 12, max: 200 });
    expectError(() => g.act(1, 'raise', 11), 'BAD_AMOUNT', 422);
    g.act(1, 'raise', 20); // raise by 13
    expect(g.minRaiseTo).toBe(33);
    g.act(2, 'call');
    expect(g.stacks[2]).toBe(180);
    g.act(0, 'call');
    expect(g.phase).toBe('flop');
    expect(g.pot).toBe(60);
    // postflop min bet is the big blind
    expect(g.legalActions(1).raise).toEqual({ min: 2, max: 180 });
    g.act(1, 'raise', 2);
    expect(g.minRaiseTo).toBe(4);
  });

  it('a short all-in does not reopen raising for players who already acted', () => {
    // Unequal stacks are needed for a short all-in to matter. Blinds 1/2; SB=1, BB=2, UTG=3.
    const g = new HoldemGame('short', { seats: [0, 1, 2, 3], button: 0, stacks: { 0: 100, 1: 100, 2: 30, 3: 100 } });
    g.act(3, 'raise', 20); // raise by 18 -> min re-raise to 38
    g.act(0, 'call');
    g.act(1, 'fold');
    expect(g.legalActions(2).raise).toEqual({ min: 30, max: 30 }); // all-in below the minimum is allowed
    g.act(2, 'raise', 30); // BB all-in: +10 < 18, not a full raise
    expect(g.history.at(-1)).toMatchObject({ seat: 2, action: 'raise', amount: 30, all_in: true });
    expect(g.minRaiseTo).toBe(48);
    expect(g.turn).toBe(3);
    // seat 3 already acted and faces only a short raise: call or fold, no raise
    expect(g.legalActions(3)).toEqual({ fold: true, check: false, call: 10, raise: null });
    expectError(() => g.act(3, 'raise', 48), 'BAD_ACTION', 400);
    g.act(3, 'call');
    expect(g.turn).toBe(0);
    expect(g.legalActions(0)).toEqual({ fold: true, check: false, call: 10, raise: null });
    g.act(0, 'call');
    expect(g.phase).toBe('flop');
    expect(g.pot).toBe(91);
  });

  it('players who have not acted yet may raise over a short all-in', () => {
    const g = new HoldemGame('short2', { seats: [0, 1, 2, 3], button: 0, stacks: { 0: 30, 1: 100, 2: 100, 3: 100 } });
    g.act(3, 'raise', 20); // by 18
    g.act(0, 'raise', 30); // button all-in short (+10)
    expect(g.legalActions(1).raise).toEqual({ min: 48, max: 100 });
    g.act(1, 'call');
    expect(g.legalActions(2).raise).toEqual({ min: 48, max: 100 }); // BB has not acted voluntarily
    g.act(2, 'call');
    expect(g.legalActions(3).raise).toBeNull();
    g.act(3, 'call');
    expect(g.phase).toBe('flop');
  });

  it('several short all-ins adding up to a full raise reopen raising', () => {
    const g = new HoldemGame('short3', { seats: [0, 1, 2, 3], button: 0, stacks: { 0: 25, 1: 31, 2: 100, 3: 100 } });
    g.act(3, 'raise', 12); // by 10
    g.act(0, 'raise', 25); // short? no: +13 >= 10 is a full raise -> min next = 38
    expect(g.minRaiseTo).toBe(38);
    g.act(1, 'raise', 31); // +6 short
    g.act(2, 'call');
    // seat 3 faced 12, now 31: +19 >= 13 -> reopened
    expect(g.legalActions(3).raise).toEqual({ min: 44, max: 100 });
  });

  it('side pots with unequal stacks', () => {
    const seats = [0, 1, 2];
    const deck = stackedDeck(seats, 0, { 0: 'AS AD', 1: 'KS KD', 2: '7C 2H' }, 'AH 9C 5D 3S JH');
    const g = new HoldemGame('side', { seats, button: 0, deck, stacks: { 0: 50, 1: 200, 2: 200 } });
    g.act(0, 'raise', 50);
    g.act(1, 'call');
    g.act(2, 'call');
    g.act(1, 'raise', 100);
    g.act(2, 'call');
    expect(g.turn).toBe(1); // seat 0 is all-in and skipped
    g.act(1, 'check');
    g.act(2, 'check');
    g.act(1, 'check');
    g.act(2, 'check');
    expect(g.result!.payouts).toEqual({ 0: 150, 1: 200, 2: 0 });
    expect(g.result!.scores).toEqual({ 0: 100, 1: 50, 2: -150 });
    expect(g.result!.winners).toEqual([0, 1]);
  });

  it('full raise after a short all-in reopens', () => {
    // 3 players with 100: UTG(button) bets, SB shoves short, BB re-raises fully -> UTG may raise again
    const g = new HoldemGame('reopen', { seats: [0, 1, 2], button: 0, stack: 100 });
    g.act(0, 'raise', 10); // by 8
    expect(g.legalActions(1).raise).toEqual({ min: 18, max: 100 });
    g.act(1, 'raise', 30); // by 20
    g.act(2, 'raise', 50); // by 20 (full)
    expect(g.legalActions(0).raise).toEqual({ min: 70, max: 100 });
  });
});

describe('hand endings', () => {
  it('fold-out win, no showdown', () => {
    const g = new HoldemGame('fold', { seats: [1, 2, 4], button: 1 });
    g.act(1, 'raise', 6);
    g.act(2, 'fold');
    const step = g.act(4, 'fold');
    expect(step.finished).toBe(true);
    expect(g.phase).toBe('finished');
    expect(g.turn).toBeNull();
    expect(g.result).toEqual({
      winners: [1],
      scores: { 1: 3, 2: -1, 4: -2 },
      payouts: { 1: 9, 2: 0, 4: 0 },
      showdown: null,
      pot: 9,
    });
    expect(g.stacks).toEqual({ 1: 203, 2: 199, 4: 198 });
  });

  it('walk: everyone folds to the big blind', () => {
    const g = new HoldemGame('walk', { seats: [0, 1, 2], button: 0 });
    g.act(0, 'fold');
    g.act(1, 'fold');
    expect(g.result!.winners).toEqual([2]);
    expect(g.result!.scores).toEqual({ 0: 0, 1: -1, 2: 1 });
  });

  it('everyone all-in preflop: board runs out in one step', () => {
    const seats = [0, 1, 2];
    const deck = stackedDeck(seats, 0, { 0: 'AS AD', 1: 'KS KD', 2: '7C 2H' }, 'AH 9C 5D 3S JH');
    const g = new HoldemGame('allin', { seats, button: 0, deck });
    g.act(0, 'raise', 200);
    g.act(1, 'call');
    const step = g.act(2, 'call');
    expect(step.action).toEqual({ seat: 2, phase: 'preflop', action: 'call', amount: 198, all_in: true });
    expect(step.streets).toEqual([
      { phase: 'flop', cards: h('AH 9C 5D') },
      { phase: 'turn', cards: ['3S'] },
      { phase: 'river', cards: ['JH'] },
    ]);
    expect(step.finished).toBe(true);
    expect(g.result!.winners).toEqual([0]);
    expect(g.result!.scores).toEqual({ 0: 400, 1: -200, 2: -200 });
    expect(g.result!.showdown!.map((e) => [e.seat, e.rank])).toEqual([
      [0, 'three_of_a_kind'],
      [1, 'pair'],
      [2, 'high_card'],
    ]);
    expect(g.result!.showdown![0]!.best).toEqual(h('AS AH AD JH 9C'));
  });

  it('all-in on the flop with one caller runs out turn and river', () => {
    const g = new HoldemGame('flopshove', { seats: [0, 1], button: 0 });
    g.act(0, 'call');
    g.act(1, 'check');
    g.act(1, 'raise', 198);
    const step = g.act(0, 'call');
    expect(step.streets.map((s) => s.phase)).toEqual(['turn', 'river']);
    expect(g.board).toHaveLength(5);
    expect(g.phase).toBe('finished');
  });

  it('split pot gives the odd chip to the first winner left of the button', () => {
    const seats = [0, 2, 5];
    // button 0 -> SB 2, BB 5. Board is a royal flush: seats 0 and 5 split; seat 2 folds the SB.
    const deck = stackedDeck(seats, 0, { 0: '2H 3D', 2: '4C 6H', 5: '7D 8C' }, 'AS KS QS JS TS');
    const g = new HoldemGame('split', { seats, button: 0, deck });
    g.act(0, 'call');
    g.act(2, 'fold');
    g.act(5, 'check');
    for (const _ of ['flop', 'turn', 'river']) {
      g.act(5, 'check');
      g.act(0, 'check');
    }
    expect(g.phase).toBe('finished');
    expect(g.result!.pot).toBe(5);
    expect(g.result!.winners).toEqual([0, 5]);
    // order left of button: 2, 5, 0 -> seat 5 gets the odd chip
    expect(g.result!.payouts).toEqual({ 0: 2, 2: 0, 5: 3 });
    expect(g.result!.scores).toEqual({ 0: 0, 2: -1, 5: 1 });
    expect(g.result!.showdown!.map((e) => e.rank)).toEqual(['straight_flush', 'straight_flush']);
  });

  it('kicker decides at showdown', () => {
    const seats = [0, 1];
    const deck = stackedDeck(seats, 0, { 0: 'AH QD', 1: 'AD JC' }, 'AS 8C 5D 3S 2H');
    const g = new HoldemGame('kick', { seats, button: 0, deck });
    g.act(0, 'call');
    g.act(1, 'check');
    for (const _ of [1, 2, 3]) {
      g.act(1, 'check');
      g.act(0, 'check');
    }
    expect(g.result!.winners).toEqual([0]);
    expect(g.result!.scores).toEqual({ 0: 2, 1: -2 });
  });
});

describe('determinism', () => {
  it('same seed deals the same cards; different seeds differ', () => {
    const a = new HoldemGame('det', { seats: [0, 1, 2, 3], button: 1 });
    const b = new HoldemGame('det', { seats: [0, 1, 2, 3], button: 1 });
    const c = new HoldemGame('det2', { seats: [0, 1, 2, 3], button: 1 });
    expect(a.holes).toEqual(b.holes);
    expect(a.holes).not.toEqual(c.holes);
    for (const g of [a, b]) {
      while (g.phase !== 'finished') g.act(g.turn!, g.legalActions(g.turn!).check ? 'check' : 'call');
    }
    expect(a.board).toEqual(b.board);
    expect(a.result).toEqual(b.result);
    expect(a.history).toEqual(b.history);
  });
});

// ------------------------------------------------------------------ self-play

// Independent, slow reference evaluator: sort-based 5-card classification over all 21 subsets.
const RANKS = '23456789TJQKA';
function refEval5(cards: string[]): number[] {
  const rs = cards.map((c) => RANKS.indexOf(c[0]!)).sort((a, b) => b - a);
  const flush = new Set(cards.map((c) => c[1])).size === 1;
  const uniq = [...new Set(rs)];
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (rs[0]! - rs[4]! === 4) straightHigh = rs[0]!;
    else if (rs.join() === '12,3,2,1,0') straightHigh = 3;
  }
  const groups = uniq
    .map((r) => [rs.filter((x) => x === r).length, r] as [number, number])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const shape = groups.map((g) => g[0]).join('');
  const byGroup = groups.map((g) => g[1]);
  if (straightHigh >= 0 && flush) return [8, straightHigh];
  if (shape === '41') return [7, ...byGroup];
  if (shape === '32') return [6, ...byGroup];
  if (flush) return [5, ...rs];
  if (straightHigh >= 0) return [4, straightHigh];
  if (shape === '311') return [3, ...byGroup];
  if (shape === '221') return [2, ...byGroup];
  if (shape === '2111') return [1, ...byGroup];
  return [0, ...rs];
}
function cmpVec(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
function refEval7(cards: string[]): number[] {
  let best: number[] | null = null;
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      const v = refEval5(five);
      if (!best || cmpVec(v, best) > 0) best = v;
    }
  return best!;
}

describe('evaluator vs reference', () => {
  it('agrees with the reference on 20k random 7-card hands', () => {
    const rng = createRng('ref');
    const deck = holdemDeck();
    const seen = new Set<string>();
    let prev: { cards: string[]; ref: number[]; score: number } | null = null;
    for (let n = 0; n < 20_000; n++) {
      const d = [...deck];
      const cards: string[] = [];
      for (let k = 0; k < 7; k++) cards.push(d.splice(Math.floor(rng() * d.length), 1)[0]!);
      const ref = refEval7(cards);
      const v = evaluateHoldem(cards);
      expect(v.score >> 20).toBe(ref[0]);
      expect(refEval5(v.best)).toEqual(ref);
      seen.add(v.rank);
      if (prev) expect(Math.sign(v.score - prev.score)).toBe(Math.sign(cmpVec(ref, prev.ref)));
      prev = { cards, ref, score: v.score };
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});

describe('random self-play', () => {
  it('5000 hands terminate, conserve chips and pay the right winners', () => {
    const rng = createRng('selfplay');
    const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    let showdowns = 0;
    let splits = 0;
    let allInRunouts = 0;
    let foldOuts = 0;
    let played = 0;
    for (let hand = 0; played < 5000; hand++) {
      const n = 2 + Math.floor(rng() * 5);
      const seats = [0, 1, 2, 3, 4, 5, 6, 7].filter(() => rng() < 0.75).slice(0, n);
      if (seats.length < 2) continue;
      played++;
      const button = pick(seats);
      const g = new HoldemGame(`sp-${hand}`, { seats, button });
      let steps = 0;
      while (g.phase !== 'finished') {
        expect(++steps).toBeLessThan(500);
        const seat = g.turn!;
        const legal = g.legalActions(seat);
        const options: (() => void)[] = [];
        if (legal.check) options.push(() => g.act(seat, 'check'), () => g.act(seat, 'check'));
        if (legal.call !== null) options.push(() => g.act(seat, 'call'), () => g.act(seat, 'call'));
        if (!legal.check && rng() < 0.6) options.push(() => g.act(seat, 'fold'));
        if (legal.raise) {
          const { min, max } = legal.raise;
          // mostly small raises, occasionally big ones
          options.push(() => g.act(seat, 'raise', min + Math.floor(rng() ** 4 * (max - min + 1))));
          if (rng() < 0.1) options.push(() => g.act(seat, 'raise', max));
        }
        const before = g.pot;
        const step = (() => {
          const o = pick(options);
          o();
          return g.history.at(-1)!;
        })();
        expect(step.seat).toBe(seat);
        expect(g.pot).toBeGreaterThanOrEqual(before);
        for (const s of seats) expect(g.stacks[s]).toBeGreaterThanOrEqual(0);
        if (g.turn !== null) {
          expect(g.folded[g.turn!]).toBe(false);
          expect(g.allIn[g.turn!]).toBe(false);
        }
      }
      const r = g.result!;
      const total = seats.reduce((a, s) => a + r.scores[s]!, 0);
      expect(total).toBe(0);
      expect(seats.reduce((a, s) => a + g.committed[s]!, 0)).toBe(r.pot);
      expect(seats.reduce((a, s) => a + r.payouts[s]!, 0)).toBe(r.pot);
      for (const s of seats) {
        expect(g.stacks[s]).toBe(200 + r.scores[s]!);
        expect(g.stacks[s]).toBeGreaterThanOrEqual(0);
      }

      // Independent recomputation of who should be paid.
      const live = seats.filter((s) => !g.folded[s]);
      const expected: Record<number, number> = Object.fromEntries(seats.map((s) => [s, 0]));
      if (live.length === 1) {
        expect(r.showdown).toBeNull();
        expected[live[0]!] = r.pot;
        foldOuts++;
      } else {
        showdowns++;
        expect(g.board).toHaveLength(5);
        if (g.history.some((x) => x.all_in)) allInRunouts++;
        // equal stacks => every live player committed the same amount
        for (const s of live) expect(g.committed[s]).toBe(g.committed[live[0]!]);
        const vals = live.map((s) => ({ s, v: refEval7([...g.holes[s]!, ...g.board]) }));
        const best = vals.reduce((m, x) => (cmpVec(x.v, m) > 0 ? x.v : m), vals[0]!.v);
        const bi = seats.indexOf(button);
        const order = [...seats.slice(bi + 1), ...seats.slice(0, bi + 1)];
        const winners = order.filter((s) => live.includes(s) && cmpVec(vals.find((x) => x.s === s)!.v, best) === 0);
        if (winners.length > 1) splits++;
        const share = Math.floor(r.pot / winners.length);
        let odd = r.pot - share * winners.length;
        for (const w of winners) expected[w] = share + (odd-- > 0 ? 1 : 0);
        expect(r.showdown!.map((e) => e.seat)).toEqual(live);
        expect([...r.winners].sort()).toEqual([...winners].sort());
      }
      expect(r.payouts).toEqual(expected);
    }
    console.log(`self-play: ${played} hands, ${showdowns} showdowns, ${foldOuts} fold-outs, ${splits} split pots, ${allInRunouts} with all-ins`);
    expect(showdowns).toBeGreaterThan(200);
    expect(foldOuts).toBeGreaterThan(200);
    expect(splits).toBeGreaterThan(0);
  });
});

describe('random self-play with unequal stacks (side pots)', () => {
  it('2000 hands conserve chips', () => {
    const rng = createRng('selfplay-side');
    const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
    for (let hand = 0; hand < 2000; hand++) {
      const seats = [0, 1, 2, 3, 4, 5].slice(0, 2 + Math.floor(rng() * 5));
      const stacks: Record<number, number> = {};
      for (const s of seats) stacks[s] = 1 + Math.floor(rng() * 300);
      const g = new HoldemGame(`side-${hand}`, { seats, button: pick(seats), stacks });
      let steps = 0;
      while (g.phase !== 'finished') {
        expect(++steps).toBeLessThan(500);
        const seat = g.turn!;
        const legal = g.legalActions(seat);
        const r = rng();
        if (legal.raise && r < 0.3) g.act(seat, 'raise', legal.raise.min + Math.floor(rng() ** 2 * (legal.raise.max - legal.raise.min + 1)));
        else if (r < 0.4) g.act(seat, 'fold');
        else g.act(seat, legal.check ? 'check' : 'call');
      }
      const res = g.result!;
      expect(seats.reduce((a, s) => a + res.scores[s]!, 0)).toBe(0);
      for (const s of seats) {
        expect(g.stacks[s]).toBe(stacks[s]! + res.scores[s]!);
        expect(g.stacks[s]).toBeGreaterThanOrEqual(0);
        // folded seats only ever get back their own uncalled chips
        if (g.folded[s]) {
          const others = Math.max(...seats.filter((o) => o !== s).map((o) => g.committed[o]!));
          expect(res.payouts[s]).toBe(Math.max(0, g.committed[s]! - others));
        }
      }
    }
  });
});
