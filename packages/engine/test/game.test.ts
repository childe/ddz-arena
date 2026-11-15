import { describe, it, expect } from 'vitest';
import { Game, GameError, legalMoves, identify, beats, createRng, type Seat } from '../src/index.ts';

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

describe('deal', () => {
  it('is deterministic per seed and deals 17/17/17/3', () => {
    const a = new Game('seed-1');
    const b = new Game('seed-1');
    expect(a.hands).toEqual(b.hands);
    expect(a.bottom).toEqual(b.bottom);
    expect(a.hands.map((h) => h.length)).toEqual([17, 17, 17]);
    expect(new Set([...a.hands.flat(), ...a.bottom]).size).toBe(54);
    expect(new Game('seed-2').hands).not.toEqual(a.hands);
  });
});

describe('bidding', () => {
  it('3 points ends bidding immediately; landlord takes the bottom and leads', () => {
    const g = new Game('b1');
    const s = g.firstBidder;
    g.bid(s, 3);
    expect(g.phase).toBe('playing');
    expect(g.landlord).toBe(s);
    expect(g.hands[s].length).toBe(20);
    expect(g.turn).toBe(s);
  });
  it('highest bidder wins after three bids', () => {
    const g = new Game('b2');
    const s = g.firstBidder;
    g.bid(s, 1);
    g.bid(((s + 1) % 3) as Seat, 2);
    g.bid(((s + 2) % 3) as Seat, 0);
    expect(g.landlord).toBe((s + 1) % 3);
    expect(g.highBid).toBe(2);
  });
  it('no bids ends with nobid', () => {
    const g = new Game('b3');
    for (let i = 0; i < 3; i++) g.bid(g.turn, 0);
    expect(g.phase).toBe('finished');
    expect(g.result?.kind).toBe('nobid');
  });
  it('rejects bad bids', () => {
    const g = new Game('b4');
    const s = g.firstBidder;
    expectError(() => g.bid(((s + 1) % 3) as Seat, 1), 'NOT_YOUR_TURN', 409);
    expectError(() => g.bid(s, 4), 'BAD_BID', 400);
    g.bid(s, 2);
    expectError(() => g.bid(g.turn, 2), 'BID_TOO_LOW', 422);
    expectError(() => g.play(g.turn, []), 'WRONG_PHASE', 409);
  });
});

describe('playing', () => {
  it('validates plays', () => {
    const g = new Game('p1');
    g.bid(g.firstBidder, 3);
    const ll = g.landlord!;
    expectError(() => g.play(ll, []), 'MUST_PLAY', 422);
    expectError(() => g.play(ll, ['ZZ']), 'UNKNOWN_CARD', 400);
    const other = g.hands[((ll + 1) % 3) as Seat][0]!;
    expectError(() => g.play(ll, [other]), 'CARDS_NOT_IN_HAND', 422);
    expectError(() => g.play(ll, [g.hands[ll][0]!, g.hands[ll][0]!]), 'CARDS_NOT_IN_HAND', 422);
    const low = g.hands[ll][0]!;
    g.play(ll, [low]);
    const next = g.turn;
    const lowest = g.hands[next].find((c) => !beats(identify([c])[0]!, identify([low])[0]!));
    if (lowest) expectError(() => g.play(next, [lowest]), 'CANNOT_BEAT', 422);
    g.play(next, []);
    g.play(g.turn, []);
    expect(g.turn).toBe(ll);
    expect(g.toBeat).toBeNull();
  });
});

describe('random self-play', () => {
  it('10000 games: legal moves always validate, scores sum to zero', () => {
    let springs = 0;
    for (let i = 0; i < 10000; i++) {
      const g = new Game(`sim-${i}`);
      const rng = createRng(`moves-${i}`);
      while (g.phase === 'bidding') {
        const want = Math.floor(rng() * 4);
        g.bid(g.turn, want > g.highBid ? want : 0);
      }
      if (g.result?.kind === 'nobid') continue;
      let steps = 0;
      while (g.phase === 'playing') {
        const moves = legalMoves(g.hands[g.turn], g.toBeat);
        const canPass = g.toBeat !== null;
        if (!canPass) expect(moves.length).toBeGreaterThan(0);
        const pick = Math.floor(rng() * (moves.length + (canPass ? 1 : 0)));
        if (pick === moves.length) g.play(g.turn, []);
        else g.play(g.turn, moves[pick]!.cards);
        if (++steps > 500) throw new Error('game did not end');
      }
      const r = g.result!;
      expect(r.scores[0] + r.scores[1] + r.scores[2]).toBe(0);
      if (r.spring || r.antiSpring) springs++;
    }
    expect(springs).toBeGreaterThan(0);
  });

  it('legal moves cover every distinct play type in a rich hand', () => {
    const hand = ['3S', '3H', '3C', '4S', '4H', '4C', '5S', '5H', '5C', '5D', '6S', '7S', '8S', '9S', 'TS', 'TH', 'BJ', 'RJ', '2S', '2H'];
    const types = new Set(legalMoves(hand, null).map((m) => m.pattern.type));
    for (const t of ['single', 'pair', 'triple', 'triple_single', 'triple_pair', 'straight', 'plane', 'plane_single',
      'plane_pair', 'four_two_single', 'four_two_pair', 'bomb', 'rocket']) expect(types.has(t as never), t).toBe(true);
  });
});
