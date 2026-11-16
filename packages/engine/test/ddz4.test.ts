import { describe, it, expect } from 'vitest';
import {
  Ddz4Game, identify4, resolve4, beats4, preferred4, legalMoves4, containsAll4, removeCards4, fullDeck4,
  PATTERN_TYPES4, type Pattern4, type PatternType4, type Ddz4Seat,
} from '../src/ddz4/index.ts';
import { GameError } from '../src/game.ts';
import { createRng, shuffle } from '../src/rng.ts';
import { rankCounts, rankOf, sortCards } from '../src/cards.ts';

// Short notation: ranks only, suits auto-assigned (S,H,C,D then again for the second deck).
// "X" small joker, "D" big joker.
function cards(s: string): string[] {
  const used: Record<string, number> = {};
  return s.split('').filter((ch) => ch !== ' ').map((ch) => {
    if (ch === 'X') return 'BJ';
    if (ch === 'D') return 'RJ';
    const i = used[ch] ?? 0;
    used[ch] = i + 1;
    return ch + 'SHCDSHCD'[i];
  });
}
const types = (s: string) => identify4(cards(s)).map((p) => p.type).sort();
const one = (s: string) => {
  const all = identify4(cards(s));
  expect(all.length, s).toBeGreaterThan(0);
  return preferred4(all)!;
};

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

describe('identify4', () => {
  const valid: [string, PatternType4[]][] = [
    ['3', ['single']],
    ['D', ['single']],
    ['33', ['pair']],
    ['XX', ['pair']],
    ['DD', ['pair']],
    ['222', ['triple']],
    ['3333', ['bomb']],
    ['33333', ['bomb']],
    ['333333', ['bomb']],
    ['3333333', ['bomb']],
    ['33333333', ['bomb']],
    ['XXDD', ['rocket']],
    ['3334', ['triple_single']],
    ['333X', ['triple_single']],
    ['33344', ['triple_pair']],
    ['333XX', ['triple_pair']],
    ['222DD', ['triple_pair']],
    ['34567', ['straight']],
    ['3456789TJQKA', ['straight']],
    ['334455', ['pair_chain']],
    ['33445566778899TTJJQQKKAA', ['pair_chain']],
    ['333444', ['plane']],
    ['33344456', ['plane_single']],
    ['33344455', ['plane_single']],
    ['333444XD', ['plane_single']],
    ['333444XX', ['plane_single']],
    ['333444555XDD', ['plane_single']],
    ['333444555666XXDD', []], // wings can't be all four jokers
    ['3334445566', ['plane_pair']],
    ['33344455XX', ['plane_pair']],
    ['333444555666', ['plane', 'plane_single', 'plane_single']],
  ];
  for (const [s, t] of valid) it(`${s} -> ${t.join(',') || 'invalid'}`, () => expect(types(s)).toEqual([...t].sort()));

  const invalid = [
    'XD', '34', '3X', 'XXD', 'XXDD3',
    '3333X', // bomb with a joker
    '33334', // four with one is not triple_single
    '333344', // no four-with-two
    '33334455', // no four-with-two-pairs
    '3456', '34562', 'TJQKA2', // straights: >=5, no 2
    '3344', 'QQKKAA22', // pair chains: >=3 pairs, no 2
    '222AAA', // plane can't include 2
    '33344445', // body rank used 4 times
    '3334445555', // pair wings must be different ranks
    '333444XXDD', // pair wings can't be all four jokers
    '3334445', '3333444', // wrong sizes
    '333444566', // 9 cards: not a plane with wings
  ];
  for (const s of invalid) it(`${s || '(empty)'} is invalid`, () => expect(identify4(cards(s))).toEqual([]));

  it('rejects two copies of the same code that are not a pair-able rank pattern', () => {
    expect(identify4(['3S', '3S']).map((p) => p.type)).toEqual(['pair']);
    expect(identify4(['3S', '3S', '3S'])).toEqual([{ type: 'triple', main: 0, length: 1 }]);
    expect(identify4(['BJ', 'RJ'])).toEqual([]);
    expect(identify4([])).toEqual([]);
  });

  it('sets bomb length to the number of cards and rocket main/length', () => {
    expect(one('77777')).toEqual({ type: 'bomb', main: 4, length: 5 });
    expect(one('22222222')).toEqual({ type: 'bomb', main: 12, length: 8 });
    expect(one('XXDD')).toEqual({ type: 'rocket', main: 14, length: 4 });
  });

  it('records chain lengths and the lowest body rank', () => {
    expect(one('456789')).toEqual({ type: 'straight', main: 1, length: 6 });
    expect(one('445566')).toEqual({ type: 'pair_chain', main: 1, length: 3 });
    expect(one('333444555666')).toEqual({ type: 'plane', main: 0, length: 4 });
    expect(one('3334445566')).toEqual({ type: 'plane_pair', main: 0, length: 2 });
  });

  it('exports the pattern type list without four_two', () => {
    expect(PATTERN_TYPES4).toHaveLength(12);
    expect(PATTERN_TYPES4).not.toContain('four_two_single' as never);
  });
});

describe('beats4', () => {
  const b = (a: string, c: string) => beats4(one(a), one(c));
  it('compares same type and length by main rank', () => {
    expect(b('4', '3')).toBe(true);
    expect(b('3', '4')).toBe(false);
    expect(b('D', 'X')).toBe(true);
    expect(b('XX', '22')).toBe(true);
    expect(b('DD', 'XX')).toBe(true);
    expect(b('45678', '34567')).toBe(true);
    expect(b('456789', '34567')).toBe(false);
    expect(b('44455', '3339')).toBe(false);
  });
  it('orders bombs: rocket > 8 > 7 > 6 > 5 > 4 cards; same size by rank', () => {
    const order = ['3333', '2222', '33333', '22222', '333333', '222222', '3333333', '2222222', '33333333', '22222222', 'XXDD'];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) expect(b(order[i]!, order[j]!), `${order[i]} vs ${order[j]}`).toBe(i > j);
    }
  });
  it('bombs beat every non-bomb; non-bombs never beat bombs', () => {
    expect(b('3333', '3456789TJQKA')).toBe(true);
    expect(b('3333', 'DD')).toBe(true);
    expect(b('XXDD', '3456789TJQKA')).toBe(true);
    expect(b('DD', '3333')).toBe(false);
    expect(b('33344455566677788899', '3333')).toBe(false);
  });
  it('resolve4 picks an interpretation that beats the table', () => {
    // 444555666777 as plane_single: body 444555666 (wings 777) or 555666777 (wings 444); the higher one wins.
    const r = resolve4(cards('444555666777'), one('333444555789'));
    expect(r).toEqual({ ok: true, pattern: { type: 'plane_single', main: 2, length: 3 } });
    expect(resolve4(cards('444555666777'), one('33344489'))).toMatchObject({ ok: false, code: 'CANNOT_BEAT' });
    expect(resolve4(cards('444555666777'), null)).toEqual({ ok: true, pattern: { type: 'plane', main: 1, length: 4 } });
    expect(resolve4(cards('3'), one('4'))).toMatchObject({ ok: false, code: 'CANNOT_BEAT' });
    expect(resolve4(cards('XD'), null)).toMatchObject({ ok: false, code: 'INVALID_PATTERN' });
    expect(resolve4(cards('333444555666'), null, 'plane_single')).toEqual({ ok: true, pattern: { type: 'plane_single', main: 1, length: 3 } });
    expect(resolve4(cards('333444555666'), null, 'straight')).toMatchObject({ ok: false, code: 'INVALID_PATTERN' });
  });
});

describe('multiset helpers', () => {
  it('fullDeck4 has 108 cards, each code exactly twice', () => {
    const d = fullDeck4();
    expect(d).toHaveLength(108);
    const m = new Map<string, number>();
    for (const c of d) m.set(c, (m.get(c) ?? 0) + 1);
    expect(m.size).toBe(54);
    expect([...m.values()].every((n) => n === 2)).toBe(true);
  });
  it('containsAll4 counts copies', () => {
    expect(containsAll4(['3S', '3S', '4H'], ['3S', '3S'])).toBe(true);
    expect(containsAll4(['3S', '4H'], ['3S', '3S'])).toBe(false);
    expect(containsAll4(['3S', '3S'], ['3S', '3S', '3S'])).toBe(false);
    expect(containsAll4(['3S'], ['3H'])).toBe(false);
    expect(containsAll4(['3S'], [])).toBe(true);
  });
  it('removeCards4 removes one copy per card', () => {
    expect(removeCards4(['3S', '3S', '4H', 'BJ', 'BJ'], ['3S', 'BJ'])).toEqual(['3S', '4H', 'BJ']);
    expect(removeCards4(['3S', '3S'], ['3S', '3S'])).toEqual([]);
  });
});

describe('legalMoves4', () => {
  it('covers every pattern type and every bomb size in a rich hand', () => {
    const hand = cards('3334445555556789TT JJQQKK XXDD 22');
    const moves = legalMoves4(hand, null);
    const seen = new Set(moves.map((m) => m.pattern.type));
    for (const t of PATTERN_TYPES4) expect(seen.has(t), t).toBe(true);
    const bombs = moves.filter((m) => m.pattern.type === 'bomb' && m.pattern.main === 2).map((m) => m.pattern.length).sort();
    expect(bombs).toEqual([4, 5, 6]);
    expect(moves.some((m) => m.pattern.type === 'pair' && m.pattern.main === 13)).toBe(true);
    expect(moves.some((m) => m.pattern.type === 'rocket')).toBe(true);
    for (const m of moves) {
      expect(containsAll4(hand, m.cards)).toBe(true);
      expect(identify4(m.cards).some((p) => p.type === m.pattern.type && p.main === m.pattern.main && p.length === m.pattern.length)).toBe(true);
    }
  });

  it('when following, returns only plays that beat the table (bombs included)', () => {
    const hand = cards('3334445555556789TT JJQQKK XXDD 22');
    const last = one('5555555'); // 7-card bomb
    const moves = legalMoves4(hand, last);
    expect(moves.map((m) => m.pattern.type)).toEqual(['rocket']);
    const vsPair = legalMoves4(hand, one('KK'));
    expect(vsPair.every((m) => beats4(m.pattern, one('KK')))).toBe(true);
    expect(vsPair.map((m) => `${m.pattern.type}:${m.pattern.main}`)).toContain('pair:13');
  });

  // Brute force: every sub-multiset of a small hand that forms a pattern must appear in legalMoves4.
  it('matches brute-force enumeration on random small hands', () => {
    const rng = createRng('brute');
    const lasts: (Pattern4 | null)[] = [null, one('5'), one('66'), one('3334'), one('33344'), one('34567'), one('334455'),
      one('333444'), one('33344456'), one('3334445566'), one('3333'), one('77777'), one('888')];
    for (let i = 0; i < 300; i++) {
      const size = 9 + Math.floor(rng() * 4);
      // Every third hand gets three jokers and draws the rest from a few ranks to force duplicates and chains.
      const pool = i % 3 === 0
        ? fullDeck4().filter((c) => rankOf(c) < 7)
        : fullDeck4();
      const hand = sortCards([...shuffle(pool, rng).slice(0, i % 3 === 0 ? size - 3 : size), ...(i % 3 === 0 ? ['BJ', 'BJ', 'RJ'] : [])]);
      const last = lasts[i % lasts.length]!;
      const expected = new Set<string>();
      const n = hand.length;
      for (let mask = 1; mask < 1 << n; mask++) {
        const sub = hand.filter((_, j) => mask & (1 << j));
        for (const p of identify4(sub)) {
          if (last && !beats4(p, last)) continue;
          expected.add(`${p.type}:${p.main}:${p.length}:${sub.map(rankOf).sort((a, b) => a - b).join(',')}`);
        }
      }
      const got = new Set(legalMoves4(hand, last).map((m) =>
        `${m.pattern.type}:${m.pattern.main}:${m.pattern.length}:${m.cards.map(rankOf).sort((a, b) => a - b).join(',')}`));
      expect([...got].sort(), hand.join(' ')).toEqual([...expected].sort());
    }
  });

  it('stays fast on 33-card hands', () => {
    const hands = [
      '333444555666777888999TTT JQKA2XXDD',
      '333444555666777888999TTTJJJ QKA2XD',
      '333444555666777 8899TTJJQQKKAA22XD',
      '33344455566677788899TTJJQQKKAA22X',
    ].map(cards);
    let worst = 0;
    for (const h of hands) {
      expect(h).toHaveLength(33);
      legalMoves4(h, null);
      const t = performance.now();
      for (let i = 0; i < 5; i++) legalMoves4(h, null);
      worst = Math.max(worst, (performance.now() - t) / 5);
    }
    // Measured ~25ms locally for the worst hand; generous bound for slow CI machines.
    expect(worst).toBeLessThan(200);
  });
});

describe('Ddz4Game deal and bidding', () => {
  it('is deterministic per seed and deals 25/25/25/25/8 from two decks', () => {
    const a = new Ddz4Game('seed-1');
    const b = new Ddz4Game('seed-1');
    expect(a.hands).toEqual(b.hands);
    expect(a.bottom).toEqual(b.bottom);
    expect(a.firstBidder).toBe(b.firstBidder);
    expect(a.hands.map((h) => h.length)).toEqual([25, 25, 25, 25]);
    expect(a.bottom).toHaveLength(8);
    expect(sortCards([...a.hands.flat(), ...a.bottom])).toEqual(sortCards(fullDeck4()));
    expect(new Ddz4Game('seed-2').hands).not.toEqual(a.hands);
  });
  it('3 points ends bidding immediately; landlord takes the bottom and leads with 33 cards', () => {
    const g = new Ddz4Game('b1');
    const s = g.firstBidder;
    g.bid(s, 3);
    expect(g.phase).toBe('playing');
    expect(g.landlord).toBe(s);
    expect(g.hands[s]).toHaveLength(33);
    expect(g.turn).toBe(s);
  });
  it('highest bidder wins after four bids', () => {
    const g = new Ddz4Game('b2');
    const s = g.firstBidder;
    const at = (k: number) => ((s + k) % 4) as Ddz4Seat;
    g.bid(s, 1);
    g.bid(at(1), 0);
    expect(g.phase).toBe('bidding');
    g.bid(at(2), 2);
    g.bid(at(3), 0);
    expect(g.landlord).toBe(at(2));
    expect(g.highBid).toBe(2);
    expect(g.highBidder).toBe(at(2));
  });
  it('four passes ends with nobid', () => {
    const g = new Ddz4Game('b3');
    for (let i = 0; i < 4; i++) {
      expect(g.autoAction()).toEqual({ kind: 'bid', score: 0 });
      g.bid(g.turn, 0);
    }
    expect(g.phase).toBe('finished');
    expect(g.result).toMatchObject({ kind: 'nobid', scores: [0, 0, 0, 0] });
    expectError(() => g.autoAction(), 'WRONG_PHASE', 409);
  });
  it('rejects bad bids', () => {
    const g = new Ddz4Game('b4');
    const s = g.firstBidder;
    expectError(() => g.bid(((s + 1) % 4) as Ddz4Seat, 1), 'NOT_YOUR_TURN', 409);
    expectError(() => g.bid(s, 4), 'BAD_BID', 400);
    expectError(() => g.bid(s, 1.5), 'BAD_BID', 400);
    g.bid(s, 2);
    expectError(() => g.bid(g.turn, 2), 'BID_TOO_LOW', 422);
    expectError(() => g.play(g.turn, []), 'WRONG_PHASE', 409);
  });
});

describe('Ddz4Game playing', () => {
  it('validates plays with multiset containment', () => {
    const g = new Ddz4Game('p1');
    g.bid(g.firstBidder, 3);
    const ll = g.landlord!;
    expectError(() => g.play(ll, []), 'MUST_PLAY', 422);
    expectError(() => g.play(ll, ['ZZ']), 'UNKNOWN_CARD', 400);
    g.hands[ll] = cards('3 4 55 X');
    expectError(() => g.play(ll, ['3S', '3S']), 'CARDS_NOT_IN_HAND', 422);
    expectError(() => g.play(ll, ['BJ', 'BJ']), 'CARDS_NOT_IN_HAND', 422);
    expectError(() => g.play(ll, ['3S', '4S']), 'INVALID_PATTERN', 422);
    expect(g.play(ll, ['5S', '5H'])).toEqual({ type: 'pair', main: 2, length: 1 });
    expect(g.hands[ll]).toEqual(['3S', '4S', 'BJ']);
    const next = g.turn;
    g.hands[next] = cards('44 XX 8');
    expectError(() => g.play(next, ['4S', '4H']), 'CANNOT_BEAT', 422);
    expect(g.autoAction()).toEqual({ kind: 'play', cards: [] });
    g.play(next, []);
    g.play(g.turn, []);
    g.play(g.turn, []);
    expect(g.turn).toBe(ll);
    expect(g.toBeat).toBeNull();
    expect(g.autoAction()).toEqual({ kind: 'play', cards: ['3S'] });
  });

  it('accepts two copies of the same card code as a pair', () => {
    const g = new Ddz4Game('p2');
    g.bid(g.firstBidder, 1);
    while (g.phase === 'bidding') g.bid(g.turn, 0);
    const ll = g.landlord!;
    g.hands[ll] = ['3S', '3S', '9H'];
    expect(g.play(ll, ['3S', '3S'])).toEqual({ type: 'pair', main: 0, length: 1 });
    expect(g.hands[ll]).toEqual(['9H']);
  });

  it('scripted game: landlord spring with a bomb', () => {
    const g = new Ddz4Game('script-1');
    g.bid(g.firstBidder, 3);
    const ll = g.landlord!;
    g.hands[ll] = cards('33344 5555');
    expect(g.play(ll, cards('33344'))).toEqual({ type: 'triple_pair', main: 0, length: 1 });
    for (let i = 0; i < 3; i++) g.play(g.turn, []);
    expect(g.turn).toBe(ll);
    expect(g.play(ll, cards('5555'))).toEqual({ type: 'bomb', main: 2, length: 4 });
    expect(g.phase).toBe('finished');
    const r = g.result!;
    expect(r).toMatchObject({ kind: 'win', winner: 'landlord', winnerSeat: ll, landlord: ll, base: 3, bombs: 1, spring: true, antiSpring: false, multiplier: 4 });
    for (const s of [0, 1, 2, 3] as Ddz4Seat[]) expect(r.scores[s]).toBe(s === ll ? 36 : -12);
    expect(g.multiplier).toBe(4);
    expect(g.history.map((h) => h.cards.length)).toEqual([5, 0, 0, 0, 4]);
  });

  it('scripted game: farmers win with a rocket, anti-spring, bomb ordering enforced', () => {
    const g = new Ddz4Game('script-2');
    const s = g.firstBidder;
    const at = (k: number) => ((s + k) % 4) as Ddz4Seat;
    g.bid(s, 1);
    g.bid(at(1), 0);
    g.bid(at(2), 2);
    g.bid(at(3), 0);
    const ll = g.landlord!;
    expect(ll).toBe(at(2));
    const f1 = nextOf(ll), f2 = nextOf(f1), f3 = nextOf(f2);
    g.hands[ll] = cards('3 99999 KKK');
    g.hands[f1] = cards('77777 4');
    g.hands[f2] = cards('888888 6');
    g.hands[f3] = cards('XXDD 5');
    g.play(ll, cards('3'));
    expect(g.play(f1, cards('77777'))).toEqual({ type: 'bomb', main: 4, length: 5 });
    expect(g.multiplier).toBe(2);
    expect(g.play(f2, cards('888888'))).toEqual({ type: 'bomb', main: 5, length: 6 });
    expect(g.play(f3, cards('XXDD'))).toEqual({ type: 'rocket', main: 14, length: 4 });
    expectError(() => g.play(ll, cards('99999')), 'CANNOT_BEAT', 422);
    g.play(ll, []);
    g.play(f1, []);
    g.play(f2, []);
    expect(g.toBeat).toBeNull();
    g.play(f3, cards('5'));
    const r = g.result!;
    expect(r).toMatchObject({ kind: 'win', winner: 'farmers', winnerSeat: f3, landlord: ll, base: 2, bombs: 3, spring: false, antiSpring: true, multiplier: 16 });
    expect(r.scores[ll]).toBe(-96);
    for (const f of [f1, f2, f3]) expect(r.scores[f]).toBe(32);
  });
});

const nextOf = (s: Ddz4Seat) => ((s + 1) % 4) as Ddz4Seat;

describe('random self-play', () => {
  it('2000 games: legal moves always validate, cards are conserved, scores sum to zero', () => {
    const deck = sortCards(fullDeck4());
    let wins = 0, springs = 0, bombs = 0;
    for (let i = 0; i < 2000; i++) {
      const g = new Ddz4Game(`sim4-${i}`);
      const rng = createRng(`moves4-${i}`);
      expect(sortCards([...g.hands.flat(), ...g.bottom])).toEqual(deck);
      while (g.phase === 'bidding') {
        const want = Math.floor(rng() * 4);
        g.bid(g.turn, want > g.highBid ? want : 0);
      }
      if (g.result?.kind === 'nobid') {
        expect(g.result.scores).toEqual([0, 0, 0, 0]);
        continue;
      }
      let steps = 0;
      while (g.phase === 'playing') {
        const seat = g.turn;
        const toBeat = g.toBeat;
        const moves = legalMoves4(g.hands[seat], toBeat);
        if (!toBeat) expect(moves.length).toBeGreaterThan(0);
        // Prefer passing less often so games finish; random otherwise.
        const pick = Math.floor(rng() * (moves.length + (toBeat ? 1 : 0)));
        if (pick === moves.length) {
          expect(g.play(seat, [])).toBeNull();
        } else {
          const m = moves[pick]!;
          const before = g.hands[seat].length;
          const p = g.play(seat, m.cards, m.pattern.type);
          expect(p).not.toBeNull();
          if (toBeat) expect(beats4(p!, toBeat)).toBe(true);
          expect(g.hands[seat].length).toBe(before - m.cards.length);
        }
        if (++steps > 2000) throw new Error('game did not end');
      }
      const r = g.result!;
      expect(r.kind).toBe('win');
      expect(r.scores.reduce((a, b) => a + b, 0)).toBe(0);
      expect(r.scores[r.landlord!]).toBe((r.winner === 'landlord' ? 3 : -3) * r.base * r.multiplier);
      // Conservation: remaining hands + every played card is exactly the two decks.
      const played = g.history.flatMap((h) => h.cards);
      expect(sortCards([...g.hands.flat(), ...played])).toEqual(deck);
      expect(g.hands[r.winnerSeat!]).toHaveLength(0);
      expect(rankCounts(played).reduce((a, b) => a + b, 0)).toBe(played.length);
      wins++;
      if (r.spring || r.antiSpring) springs++;
      bombs += r.bombs;
    }
    expect(wins).toBeGreaterThan(1000);
    expect(bombs).toBeGreaterThan(0);
    expect(springs).toBeGreaterThanOrEqual(0);
  }, 300_000);
});
