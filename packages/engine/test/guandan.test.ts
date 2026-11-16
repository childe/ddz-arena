import { describe, it, expect } from 'vitest';
import {
  GuandanGame, newMatch, nextMatch, settleHand, identifyGd, resolveGd, beatsGd, legalMovesGd, preferredGd,
  cardValue, sortByValue, teamOf, GD_LEVELS,
  type GdPattern, type GdPatternType, type GdLevel, type GdSeat, type GdHands, type GuandanMatch,
} from '../src/guandan/index.ts';
import { GameError } from '../src/game.ts';
import { createRng, shuffle } from '../src/rng.ts';
import { sortCards } from '../src/cards.ts';
import { fullDeck4 } from '../src/ddz4/cards4.ts';

const c = (s: string) => s.split(' ').filter(Boolean);
const types = (s: string, level: GdLevel = '2') =>
  identifyGd(c(s), level).map((p) => `${p.type}:${p.rank}${p.type === 'bomb' ? `x${p.length}` : ''}`).sort();
const P = (type: GdPatternType, rank: string, length = 1): GdPattern => ({ type, rank, length });

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

describe('card values', () => {
  it('lifts the level rank above A, below the jokers', () => {
    expect(sortByValue(c('RJ 7S AS 8S 6S BJ 2S'), '7')).toEqual(c('2S 6S 8S AS 7S BJ RJ'));
    expect(sortByValue(c('AS 2S 3S BJ'), '2')).toEqual(c('3S AS 2S BJ'));
    expect(cardValue('7H', '7')).toBe(cardValue('7S', '7'));
    expect(cardValue('AS', 'A')).toBeGreaterThan(cardValue('KS', 'A'));
  });

  it('single, pair and bomb comparisons follow the level', () => {
    expect(beatsGd(P('single', '7'), P('single', 'A'), '7')).toBe(true);
    expect(beatsGd(P('single', '7'), P('single', 'A'), '5')).toBe(false);
    expect(beatsGd(P('single', 'BJ'), P('single', '7'), '7')).toBe(true);
    expect(beatsGd(P('pair', '2'), P('pair', 'A'), '2')).toBe(true);
    expect(beatsGd(P('bomb', '3', 4), P('bomb', 'A', 4), '3')).toBe(true);
    // Sequences use natural order regardless of the level.
    expect(beatsGd(P('straight', '8'), P('straight', '7'), '7')).toBe(true);
  });
});

describe('identifyGd', () => {
  const cases: [string, GdLevel, string[]][] = [
    ['5S', '2', ['single:5']],
    ['BJ BJ', '2', ['pair:BJ']],
    ['RJ RJ', '2', ['pair:RJ']],
    ['5S 5D 5D', '2', ['triple:5']],
    ['5S 5H 5C 5D', '2', ['bomb:5x4']],
    ['5S 5H 5C 5D 5S 5H 5C 5D', '2', ['bomb:5x8']],
    ['BJ BJ RJ RJ', '2', ['rocket:RJ']],
    ['5S 5H 5C 9D 9D', '2', ['triple_pair:5']],
    ['5S 5H 5C BJ BJ', '2', ['triple_pair:5']],
    ['3S 4H 5C 6D 7S', '2', ['straight:7']],
    ['AS 2H 3C 4D 5S', '7', ['straight:5']],
    ['TS JH QC KD AS', '7', ['straight:A']],
    ['3S 4S 5S 6S 7S', '2', ['straight:7', 'straight_flush:7']],
    ['3S 3H 4C 4D 5S 5S', '2', ['pair_chain:5']],
    ['AS AH 2C 2D 3S 3S', '9', ['pair_chain:3']],
    ['QS QH KC KD AS AS', '9', ['pair_chain:A']],
    ['AS AH AC 2D 2S 2H', '9', ['plane:2']],
    ['KS KH KC AD AS AH', '9', ['plane:A']],
    ['5S 5H 5C 6D 6S 6H', '2', ['plane:6']],
  ];
  for (const [s, lv, want] of cases) it(`${s} @${lv} -> ${want.join(',')}`, () => expect(types(s, lv)).toEqual(want.sort()));

  const invalid = [
    'BJ RJ', '5S 6S', 'BJ BJ BJ', 'BJ BJ RJ', '5S 5H 5C 5D BJ',
    'QS KH AC 2D 3S', // no wrap
    '3S 4H 5C 6D 7S 8S', // straights are exactly 5
    '3S 3H 4C 4D 5S 5S 6S 6S', // pair chains are exactly 3 pairs
    '5S 5H 5C 6D 6S 6H 7S 7H 7C', // planes are exactly 2 triples
    '5S 5H 5C 5D 5S 5H 5C 5D 5S', // bombs are at most 8 cards
    '3S 4H 5C 6D BJ',
  ];
  for (const s of invalid) it(`${s} is invalid`, () => expect(identifyGd(c(s), '2')).toEqual([]));

  it('four of a kind plus one more is a 5-card bomb, not triple_pair', () => expect(types('5S 5H 5C 5D 5S')).toEqual(['bomb:5x5']));

  describe('wildcards (level 7: 7H)', () => {
    const w: [string, string[]][] = [
      ['7H', ['single:7']],
      ['7H 7H', ['pair:7']],
      ['7H 7S', ['pair:7']],
      ['7H 5S', ['pair:5']],
      ['7H 7H 5S', ['triple:5']],
      ['7H 5S 5D 5C', ['bomb:5x4']],
      ['7H 7H 5S 5D 5C 5S 5D 5C', ['bomb:5x8']],
      ['7H 7S 7C 7D', ['bomb:7x4']],
      ['7H 5S 5D 9C 9S', ['triple_pair:5', 'triple_pair:9']],
      ['7H 7H 5S 5D 5C', ['bomb:5x5', 'triple_pair:5']],
      ['7H 5S 5D 5C BJ', []], // the wildcard cannot be a joker
      ['7H BJ', []],
      ['7H BJ BJ RJ', []], // rocket needs four real jokers
      ['3S 4S 5S 6S 7H', ['straight:6', 'straight:7', 'straight_flush:6', 'straight_flush:7']],
      ['3S 4D 5S 6S 7H', ['straight:6', 'straight:7']],
      ['AS 2S 3S 4S 7H', ['straight:5', 'straight_flush:5']],
      ['JS QS KS AS 7H', ['straight:A', 'straight_flush:A']],
      ['3S 5D 6S 7H 7H', ['straight:6', 'straight:7']],
      ['3S 3H 4C 5D 7H 7H', ['pair_chain:5']],
      ['5S 5H 6C 6D 7H 7H', ['pair_chain:6', 'pair_chain:7', 'plane:6']],
      ['5S 5H 5C 6D 7H 7H', ['plane:6']],
      ['AS AH 2C 7H 3S 3S', ['pair_chain:3']],
    ];
    for (const [s, want] of w) it(`${s} -> ${want.join(',') || 'invalid'}`, () => expect(types(s, '7')).toEqual(want.sort()));

    it('other hearts of the level rank are wildcards only at that level', () => {
      expect(types('7H 5S', '8')).toEqual([]);
      expect(types('8H 5S', '8')).toEqual(['pair:5']);
    });
  });
});

describe('bomb ordering', () => {
  const ladder = [
    P('bomb', '3', 4), P('bomb', 'A', 4), P('bomb', '2', 4), P('bomb', '3', 5), P('bomb', '2', 5),
    P('straight_flush', '5'), P('straight_flush', 'A'), P('bomb', '3', 6), P('bomb', '3', 7), P('bomb', 'A', 8),
    P('bomb', '2', 8), P('rocket', 'RJ', 4),
  ];
  it('4 < 5 < straight flush < 6 < 7 < 8 < rocket, same class by rank (level 2)', () => {
    for (let i = 0; i < ladder.length; i++) {
      for (let j = 0; j < ladder.length; j++) {
        expect(beatsGd(ladder[i]!, ladder[j]!, '2'), `${i} vs ${j}`).toBe(i > j);
      }
    }
  });
  it('bomb classes beat every non-bomb; non-bombs need the same type', () => {
    expect(beatsGd(P('bomb', '3', 4), P('straight', 'A'), '2')).toBe(true);
    expect(beatsGd(P('straight_flush', '5'), P('pair', 'RJ'), '2')).toBe(true);
    expect(beatsGd(P('pair', 'RJ'), P('bomb', '3', 4), '2')).toBe(false);
    expect(beatsGd(P('pair', 'A'), P('single', '3'), '2')).toBe(false);
    expect(beatsGd(P('straight', 'A'), P('straight_flush', '5'), '2')).toBe(false);
  });
});

describe('resolveGd', () => {
  it('leading picks the strongest interpretation: bombs first', () => {
    expect(resolveGd(c('7H 7H 5S 5D 5C'), null, '7')).toEqual({ ok: true, pattern: P('bomb', '5', 5) });
    expect(resolveGd(c('3S 4S 5S 6S 7H'), null, '7')).toEqual({ ok: true, pattern: P('straight_flush', '7') });
    expect(resolveGd(c('3S 4D 5S 6S 7H'), null, '7')).toEqual({ ok: true, pattern: P('straight', '7') });
    expect(resolveGd(c('7H 5S 5D 9C 9S'), null, '7')).toEqual({ ok: true, pattern: P('triple_pair', '9') });
  });

  it('following picks the weakest interpretation that beats the table', () => {
    expect(resolveGd(c('3S 4D 5S 6S 7H'), P('straight', '5'), '7')).toEqual({ ok: true, pattern: P('straight', '6') });
    expect(resolveGd(c('3S 4D 5S 6S 7H'), P('straight', '6'), '7')).toEqual({ ok: true, pattern: P('straight', '7') });
    expect(resolveGd(c('7H 5S 5D 9C 9S'), P('triple_pair', '3'), '7')).toEqual({ ok: true, pattern: P('triple_pair', '5') });
    expect(resolveGd(c('3S 4S 5S 6S 7H'), P('straight', 'A'), '7')).toEqual({ ok: true, pattern: P('straight_flush', '6') });
  });

  it('hints restrict the interpretation; impossible hints are PATTERN_MISMATCH', () => {
    expect(resolveGd(c('7H 7H 5S 5D 5C'), null, '7', { type: 'triple_pair' })).toEqual({ ok: true, pattern: P('triple_pair', '5') });
    expect(resolveGd(c('3S 4S 5S 6S 7H'), null, '7', { type: 'straight', rank: '6' })).toEqual({ ok: true, pattern: P('straight', '6') });
    expect(resolveGd(c('3S 4S 5S 6S 7H'), null, '7', { type: 'straight' })).toEqual({ ok: true, pattern: P('straight', '7') });
    expect(resolveGd(c('3S 4S 5S 6S 7H'), null, '7', { type: 'straight', rank: '8' })).toMatchObject({ ok: false, code: 'PATTERN_MISMATCH' });
    expect(resolveGd(c('5S 5D'), null, '7', { type: 'single' })).toMatchObject({ ok: false, code: 'PATTERN_MISMATCH' });
    expect(resolveGd(c('5S 6D'), null, '7', { type: 'pair' })).toMatchObject({ ok: false, code: 'INVALID_PATTERN' });
    expect(resolveGd(c('5S 5D'), P('pair', '6'), '7')).toMatchObject({ ok: false, code: 'CANNOT_BEAT' });
    expect(resolveGd(c('3S 4S 5S 6S 7H'), P('straight', 'A'), '7', { type: 'straight' })).toMatchObject({ ok: false, code: 'CANNOT_BEAT' });
  });

  it('preferredGd breaks rank ties by type order', () => {
    expect(preferredGd([P('pair_chain', '6'), P('plane', '6')], '2')).toEqual(P('pair_chain', '6'));
  });
});

// Brute-force reference: every sub-multiset of the hand, every interpretation that beats `toBeat`, keyed
// like legalMovesGd (rank tokens with W for wildcards; exact codes for straight flushes).
function bruteKeys(hand: string[], toBeat: GdPattern | null, level: GdLevel): Set<string> {
  const wild = level + 'H';
  const codes = [...new Set(hand)];
  const max = codes.map((x) => hand.filter((h) => h === x).length);
  const keys = new Set<string>();
  const cur: string[] = [];
  const rec = (i: number) => {
    if (i === codes.length) {
      if (!cur.length) return;
      for (const p of identifyGd(cur, level)) {
        if (toBeat && !beatsGd(p, toBeat, level)) continue;
        keys.add(moveKey(cur, p, wild));
      }
      return;
    }
    for (let k = 0; k <= max[i]!; k++) {
      for (let j = 0; j < k; j++) cur.push(codes[i]!);
      rec(i + 1);
      for (let j = 0; j < k; j++) cur.pop();
    }
  };
  rec(0);
  return keys;
}
function moveKey(cards: string[], p: GdPattern, wild: string): string {
  const toks = p.type === 'straight_flush' ? [...cards] : cards.map((x) => (x === wild ? 'W' : x.length === 2 && x[1] !== 'J' ? x[0]! : x));
  return `${p.type}:${p.rank}:${p.length}:${toks.sort().join(',')}`;
}

describe('legalMovesGd', () => {
  it('lists wildcard plays and every pattern type', () => {
    const hand = c('3S 4S 5S 6S 7H 7H 7S 9D 9C 9S 9H BJ BJ RJ RJ');
    const moves = legalMovesGd(hand, null, '7');
    const has = (cards: string, type: GdPatternType, rank: string) =>
      moves.some((m) => m.pattern.type === type && m.pattern.rank === rank && m.cards.join(' ') === sortCards(c(cards)).join(' '));
    expect(has('7H', 'single', '7')).toBe(true);
    expect(has('7S', 'single', '7')).toBe(true);
    expect(has('7H 7H', 'pair', '7')).toBe(true);
    expect(has('7S 7H', 'pair', '7')).toBe(true);
    expect(has('3S 7H', 'pair', '3')).toBe(true);
    expect(has('9S 9H 9C 9D 7H 7H', 'bomb', '9')).toBe(true);
    expect(has('3S 4S 5S 6S 7H', 'straight_flush', '7')).toBe(true);
    expect(has('3S 4S 5S 6S 7H', 'straight_flush', '6')).toBe(true);
    expect(has('3S 4S 5S 6S 7S', 'straight_flush', '7')).toBe(true);
    expect(has('BJ BJ RJ RJ', 'rocket', 'RJ')).toBe(true);
    expect(has('9S 9H 9C BJ BJ', 'triple_pair', '9')).toBe(true);
    expect(has('7H 7H 7S 9S 9H', 'triple_pair', '7')).toBe(true);
    expect(moves.some((m) => m.pattern.type === 'pair' && m.cards.includes('BJ') && m.cards.includes('7H'))).toBe(false);
    expect(moves.some((m) => m.pattern.type === 'rocket' && m.cards.includes('7H'))).toBe(false);
  });

  it('when following, only plays that beat the table', () => {
    const hand = c('3S 4S 5S 6S 7H 8D 8C 8S 8H QS');
    const moves = legalMovesGd(hand, P('straight', '6'), '7');
    expect(moves.map((m) => `${m.pattern.type}:${m.pattern.rank}:${m.cards.join(' ')}`).sort()).toEqual([
      'bomb:8:8S 8H 8C 8D', 'bomb:8:7H 8S 8H 8C', 'bomb:8:7H 8S 8H 8C 8D',
      'straight:7:3S 4S 5S 6S 7H', 'straight:8:4S 5S 6S 7H 8S',
      // The wildcard can be the 2 (top 6), the 7 or, with 8S, the 7 of a 4–8 flush.
      'straight_flush:6:3S 4S 5S 6S 7H', 'straight_flush:7:3S 4S 5S 6S 7H', 'straight_flush:8:4S 5S 6S 7H 8S',
    ].sort());
    expect(legalMovesGd(c('3S 4S'), P('bomb', '3', 4), '7')).toEqual([]);
  });

  it('matches brute-force enumeration on random small hands', () => {
    const rng = createRng('gd-brute');
    for (let i = 0; i < 120; i++) {
      const level = GD_LEVELS[Math.floor(rng() * 13)]!;
      const deck = shuffle(fullDeck4(), rng);
      const hand = deck.slice(0, 9);
      // Make wildcards frequent.
      if (i % 2 === 0) hand.push(level + 'H');
      if (i % 4 === 0) hand.push(level + 'H');
      const w = hand.filter((x) => x === level + 'H').length;
      if (w > 2) hand.splice(hand.indexOf(level + 'H'), 1);
      const tables: (GdPattern | null)[] = [null, P('single', '9'), P('pair', '5'), P('straight', '6'), P('bomb', '6', 4), P('triple_pair', '4')];
      for (const t of tables) {
        const got = new Set(legalMovesGd(hand, t, level).map((m) => moveKey(m.cards, m.pattern, level + 'H')));
        expect([...got].sort(), `${hand.join(' ')} @${level} vs ${JSON.stringify(t)}`).toEqual([...bruteKeys(hand, t, level)].sort());
      }
    }
  });

  it('every move resolves to its own pattern with a hint and beats the table', () => {
    const rng = createRng('gd-resolve');
    for (let i = 0; i < 40; i++) {
      const level = GD_LEVELS[i % 13]!;
      const hand = shuffle(fullDeck4(), rng).slice(0, 27);
      for (const t of [null, P('single', '8'), P('pair_chain', '5'), P('plane', '9'), P('straight_flush', '8')]) {
        for (const m of legalMovesGd(hand, t, level)) {
          const r = resolveGd(m.cards, t, level, { type: m.pattern.type, rank: m.pattern.rank });
          expect(r, JSON.stringify(m)).toEqual({ ok: true, pattern: m.pattern });
          if (t) expect(beatsGd(m.pattern, t, level)).toBe(true);
        }
      }
    }
  });

  it('enumerates a 27-card hand with 2 wildcards well under 50 ms', () => {
    const rng = createRng('gd-speed');
    const hands: string[][] = [
      c('2S 3S 4S 5S 6S 7S 8S 9S TS JS QS KS AS 2H 3H 4H 5H 6H 8H 9H TH JH QH KH AH 7H 7H'),
      c('3S 3H 3C 3D 4S 4H 4C 4D 5S 5H 5C 5D 6S 6H 6C 6D 8S 8H 8C 8D 9S 9H 9C BJ RJ 7H 7H'),
    ];
    while (hands.length < 8) {
      const rest = shuffle(fullDeck4().filter((x) => x !== '7H'), rng).slice(0, 25);
      hands.push([...rest, '7H', '7H']);
    }
    let worst = 0;
    for (const h of hands) {
      expect(h).toHaveLength(27);
      legalMovesGd(h, null, '7');
      const t = performance.now();
      for (let i = 0; i < 5; i++) legalMovesGd(h, null, '7');
      worst = Math.max(worst, (performance.now() - t) / 5);
    }
    console.log(`legalMovesGd worst average on 27-card hands with 2 wildcards: ${worst.toFixed(2)} ms`);
    expect(worst).toBeLessThan(50);
  });
});

const matchAfter = (prevOrder: GdSeat[], extra: Partial<GuandanMatch> = {}): GuandanMatch =>
  ({ ...newMatch(), handNo: 2, prevOrder, ...extra });
const deal = (a: string, b: string, cc: string, d: string): GdHands => [c(a), c(b), c(cc), c(d)];

describe('GuandanGame deal and first hand', () => {
  it('is deterministic per seed and deals 27 each from two decks', () => {
    const g = new GuandanGame('deal-1', newMatch());
    const h = new GuandanGame('deal-1', newMatch());
    expect(g.hands).toEqual(h.hands);
    expect(g.turn).toBe(h.turn);
    expect(g.hands.map((x) => x.length)).toEqual([27, 27, 27, 27]);
    expect(sortCards(g.hands.flat())).toEqual(sortCards(fullDeck4()));
    expect(g.phase).toBe('playing');
    expect(g.tribute).toBeNull();
    expect(g.level).toBe('2');
    expect(g.handNo).toBe(1);
    const seats = new Set(Array.from({ length: 40 }, (_, i) => new GuandanGame(`lead-${i}`, newMatch()).turn));
    expect(seats.size).toBe(4);
  });
});

describe('tribute and return', () => {
  it('single down: last pays the first finisher its highest non-wildcard card (suit order S H C D)', () => {
    // Previous order 1,3? No: 2 first, 1 second, 0 third, 3 last; 3's partner (1) is not third => single down.
    const g = new GuandanGame('t1', matchAfter([2, 1, 0, 3], { teamLevels: ['2', '7'], levelTeam: 1 }), deal(
      '3S 4S', '5S 6S', '8S 9S 9H', '7H 7H 7C AS AD 7D BJ',
    ));
    expect(g.level).toBe('7');
    expect(g.anti).toBe(false);
    expect(g.tributes).toEqual([{ from: 3, to: 2, card: 'BJ' }]);
    expect(g.hands[3]).not.toContain('BJ');
    expect(g.hands[2]).toContain('BJ');
    expect(g.phase).toBe('return');
    expect(g.turn).toBe(2);
    expect(g.tribute).toEqual({ anti: false, tributes: [{ from: 3, to: 2, card: 'BJ' }] });
    expect(g.initialHands[3]).toContain('BJ');
  });

  it('tribute skips the wildcard and breaks equal values by suit', () => {
    // Double down (1 and 3 pay). Level 2: 2H is the wildcard; seat 3's best other card is a level card, 2C before 2D.
    const g = new GuandanGame('t2', matchAfter([0, 2, 1, 3]), deal('3S', '4S', '5S', '2H 2H 2D 2C KS'));
    expect(g.tributes).toEqual([{ from: 3, to: 0, card: '2C' }, { from: 1, to: 2, card: '4S' }]);
    // Single down: only seat 1 pays.
    const h = new GuandanGame('t2', matchAfter([0, 3, 2, 1]), deal('3S', '4S', '5S', '2H 2H 2D 2C KS'));
    expect(h.tributes).toEqual([{ from: 1, to: 0, card: '4S' }]);
  });

  it('double down: bigger tribute to the first finisher, smaller to the second; returns in that order', () => {
    const g = new GuandanGame('t3', matchAfter([0, 2, 3, 1]), deal('3S 4S', 'QS 5D', '6S 8S', 'AS 9D'));
    expect(g.tributes).toEqual([{ from: 3, to: 0, card: 'AS' }, { from: 1, to: 2, card: 'QS' }]);
    expect(g.turn).toBe(0);
    expect(g.pendingReturns).toEqual([{ from: 0, to: 3 }, { from: 2, to: 1 }]);
    expectError(() => g.returnCard(2, '6S'), 'NOT_YOUR_TURN', 409);
    expectError(() => g.play(0, ['3S']), 'WRONG_PHASE', 409);
    expectError(() => g.returnCard(0, 'AS'), 'BAD_RETURN', 422);
    expectError(() => g.returnCard(0, '9S'), 'CARDS_NOT_IN_HAND', 422);
    expectError(() => g.returnCard(0, 'XX'), 'UNKNOWN_CARD', 400);
    expect(g.returnableCards(0)).toEqual(['3S', '4S']);
    expect(g.autoAction()).toEqual({ kind: 'return', card: '3S' });
    expect(g.returnCard(0, '4S')).toEqual({ from: 0, to: 3, card: '4S' });
    expect(g.turn).toBe(2);
    g.returnCard(2, '8S');
    expect(g.returns).toEqual([{ from: 0, to: 3, card: '4S' }, { from: 2, to: 1, card: '8S' }]);
    expect(g.phase).toBe('playing');
    // The payer who gave to the first finisher leads.
    expect(g.turn).toBe(3);
    expect(g.hands).toEqual([['3S', 'AS'], ['8S', '5D'], ['6S', 'QS'], ['4S', '9D']].map(sortCards));
  });

  it('double down with equal tributes: the payer first met after the first finisher pays the first finisher', () => {
    const g = new GuandanGame('t4', matchAfter([2, 0, 1, 3]), deal('3S', 'AS 3D', '4S', 'AH 5D'));
    expect(g.tributes).toEqual([{ from: 3, to: 2, card: 'AH' }, { from: 1, to: 0, card: 'AS' }]);
    const h = new GuandanGame('t4', matchAfter([0, 2, 1, 3]), deal('3S', 'AS 3D', '4S', 'AH 5D'));
    expect(h.tributes).toEqual([{ from: 1, to: 0, card: 'AS' }, { from: 3, to: 2, card: 'AH' }]);
  });

  it('anti-tribute: two big jokers with the single payer, or between the two double-down payers', () => {
    const single = new GuandanGame('t5', matchAfter([1, 2, 3, 0]), deal('RJ RJ 3S', '4S', '5S', '6S'));
    expect(single.anti).toBe(true);
    expect(single.tributes).toEqual([]);
    expect(single.tribute).toEqual({ anti: true, tributes: [] });
    expect(single.phase).toBe('playing');
    expect(single.turn).toBe(1);
    const one = new GuandanGame('t5', matchAfter([1, 2, 3, 0]), deal('RJ 3S', '4S', '5S', 'RJ 6S'));
    expect(one.anti).toBe(false);
    const dbl = new GuandanGame('t6', matchAfter([1, 3, 0, 2]), deal('RJ 3S', '4S', 'RJ 5S', '6S'));
    expect(dbl.anti).toBe(true);
    expect(dbl.turn).toBe(1);
  });

  it('receivers without a 2–10 card may return any non-wildcard card', () => {
    const g = new GuandanGame('t7', matchAfter([0, 1, 2, 3]), deal('JS QS 2H', '3S', '4S', 'KS 5S'));
    expect(g.tributes).toEqual([{ from: 3, to: 0, card: 'KS' }]);
    expect(g.returnableCards(0)).toEqual(['JS', 'QS', 'KS']);
  });
});

describe('playing', () => {
  it('validates plays and passes', () => {
    const g = new GuandanGame('p1', newMatch(), deal('3S 4D 5S 6S 2H 9S', '7S 8S', '9H TH', 'JS QS'));
    g.turn = 0;
    expectError(() => g.play(0, []), 'MUST_PLAY', 422);
    expectError(() => g.play(0, ['ZZ']), 'UNKNOWN_CARD', 400);
    expectError(() => g.play(1, ['7S']), 'NOT_YOUR_TURN', 409);
    expectError(() => g.play(0, ['9S', '9S']), 'CARDS_NOT_IN_HAND', 422);
    expectError(() => g.play(0, ['3S', '9S']), 'INVALID_PATTERN', 422);
    expectError(() => g.returnCard(0, '3S'), 'WRONG_PHASE', 409);
    // Leading timeout: lowest single, never the wildcard while something else is left.
    expect(g.autoAction()).toEqual({ kind: 'play', cards: ['3S'] });
    g.hands[0] = c('2H AS');
    expect(g.autoAction()).toEqual({ kind: 'play', cards: ['AS'] });
    g.hands[0] = c('2H');
    expect(g.autoAction()).toEqual({ kind: 'play', cards: ['2H'] });
  });

  it('scripted hand: wildcard straight, 接风 to the partner twice, three out ends the hand', () => {
    const g = new GuandanGame('p2', newMatch(), deal('3S 4D 5S 6S 2H', '7S 8S 8D QS', '9H TH 4S', 'JS QD KS 3D'));
    g.turn = 0;
    expectError(() => g.play(0, c('3S 4D 5S 6S 2H'), { type: 'straight', rank: '8' }), 'PATTERN_MISMATCH', 422);
    expect(g.play(0, c('3S 4D 5S 6S 2H'))).toEqual(P('straight', '7'));
    expect(g.order).toEqual([0]);
    expect(g.turn).toBe(1);
    expect(g.canPass).toBe(true);
    expect(g.autoAction()).toEqual({ kind: 'play', cards: [] });
    g.play(1, []);
    g.play(2, []);
    g.play(3, []);
    // Nobody beat seat 0's last play: its partner leads.
    expect(g.toBeat).toBeNull();
    expect(g.turn).toBe(2);
    g.play(2, c('4S'));
    g.play(3, c('JS'));
    expect(g.turn).toBe(1); // seat 0 is out and skipped
    expectError(() => g.play(1, c('7S')), 'CANNOT_BEAT', 422);
    g.play(1, c('QS'));
    g.play(2, []);
    g.play(3, c('KS'));
    g.play(1, []);
    g.play(2, []);
    expect(g.turn).toBe(3);
    g.play(3, c('3D'));
    g.play(1, c('7S'));
    g.play(2, c('9H'));
    g.play(3, c('QD'));
    expect(g.order).toEqual([0, 3]);
    expect(g.turn).toBe(1);
    g.play(1, []);
    g.play(2, []);
    // Seat 3 went out unbeaten: partner seat 1 leads.
    expect(g.turn).toBe(1);
    expect(g.toBeat).toBeNull();
    g.play(1, c('8S 8D'));
    expect(g.phase).toBe('finished');
    expect(g.cardsLeft).toEqual([0, 0, 1, 0]);
    expect(g.result).toEqual({
      order: [0, 3, 1, 2], winner_team: 0, upgrade: 1, level: '2', team_levels_before: ['2', '2'],
      team_levels_after: ['3', '2'], level_team_next: 0, a_attempts: [0, 0], match_winner: null, scores: [1, -1, 1, -1],
    });
    expect(() => g.autoAction()).toThrow(GameError);
  });

  it('a team going out together ends the hand; the rest rank from the last finisher\'s next seat', () => {
    const g = new GuandanGame('p3', newMatch(), deal('3S', 'KS KD', '4S', 'AS AD'));
    g.turn = 0;
    g.play(0, c('3S'));
    g.play(1, []);
    g.play(2, c('4S'));
    expect(g.phase).toBe('finished');
    expect(g.result!.order).toEqual([0, 2, 3, 1]);
    expect(g.result!.upgrade).toBe(3);
    expect(g.result!.scores).toEqual([3, -3, 3, -3]);
  });

  it('a beaten last play does not trigger 接风; the player who beat it leads', () => {
    const g = new GuandanGame('p4', newMatch(), deal('3S', '5S 9S', '4S 6S', 'KS KD'));
    g.turn = 0;
    g.play(0, c('3S'));
    g.play(1, c('5S'));
    g.play(2, []);
    g.play(3, []);
    expect(g.turn).toBe(1);
    expect(g.toBeat).toBeNull();
  });
});

describe('match progression', () => {
  const m0 = newMatch();
  it('upgrades 3/2/1 by the partner\'s place and passes the level to the winners', () => {
    expect(settleHand(m0, [1, 3, 0, 2])).toMatchObject({ winner_team: 1, upgrade: 3, team_levels_after: ['2', '5'], level_team_next: 1, scores: [-3, 3, -3, 3] });
    expect(settleHand(m0, [1, 0, 3, 2])).toMatchObject({ upgrade: 2, team_levels_after: ['2', '4'] });
    expect(settleHand(m0, [0, 1, 3, 2])).toMatchObject({ upgrade: 1, team_levels_after: ['3', '2'], level_team_next: 0 });
    const m: GuandanMatch = { handNo: 4, teamLevels: ['5', '7'], levelTeam: 1, aAttempts: [0, 0], prevOrder: [1, 0, 3, 2] };
    expect(settleHand(m, [2, 0, 1, 3])).toEqual({
      order: [2, 0, 1, 3], winner_team: 0, upgrade: 3, level: '7', team_levels_before: ['5', '7'], team_levels_after: ['8', '7'],
      level_team_next: 0, a_attempts: [0, 0], match_winner: null, scores: [3, -3, 3, -3],
    });
    expect(nextMatch(m, settleHand(m, [2, 0, 1, 3]))).toEqual({
      handNo: 5, teamLevels: ['8', '7'], levelTeam: 0, aAttempts: [0, 0], prevOrder: [2, 0, 1, 3],
    });
  });

  it('caps at A', () => {
    const m: GuandanMatch = { handNo: 9, teamLevels: ['Q', '3'], levelTeam: 1, aAttempts: [0, 0], prevOrder: [0, 1, 2, 3] };
    expect(settleHand(m, [0, 2, 1, 3]).team_levels_after).toEqual(['A', '3']);
  });

  it('过 A: the level team at A finishing first with the partner not last wins the match; then everything resets', () => {
    const m: GuandanMatch = { handNo: 12, teamLevels: ['A', '9'], levelTeam: 0, aAttempts: [1, 0], prevOrder: [0, 1, 2, 3] };
    const r = settleHand(m, [2, 1, 0, 3]);
    expect(r).toMatchObject({ match_winner: 0, upgrade: 2, team_levels_after: ['2', '2'], level_team_next: 0, a_attempts: [0, 0], scores: [5, -5, 5, -5] });
    expect(nextMatch(m, r)).toEqual(newMatch());
    // Partner last: no match win, one A attempt used.
    const r2 = settleHand(m, [2, 1, 3, 0]);
    expect(r2).toMatchObject({ match_winner: null, upgrade: 1, team_levels_after: ['A', '9'], a_attempts: [2, 0], level_team_next: 0 });
    // Opponents finish first: they go up and take the level; the A attempt still counts.
    const r3 = settleHand(m, [1, 3, 0, 2]);
    expect(r3).toMatchObject({ match_winner: null, team_levels_after: ['A', 'Q'], a_attempts: [2, 0], level_team_next: 1 });
    // A team at A that is not the level team cannot win the match, and the hand (played at 9) uses no attempt.
    const m2: GuandanMatch = { ...m, teamLevels: ['A', '9'], levelTeam: 1 };
    expect(settleHand(m2, [0, 2, 1, 3])).toMatchObject({ match_winner: null, level: '9', team_levels_after: ['A', '9'], level_team_next: 0, a_attempts: [1, 0] });
  });

  it('three failed hands at A send the level team back to 2', () => {
    let m: GuandanMatch = { handNo: 20, teamLevels: ['A', 'K'], levelTeam: 0, aAttempts: [0, 0], prevOrder: [0, 1, 2, 3] };
    // Fail twice with partner last (team 0 keeps the level), then the opponents win the third hand.
    for (const order of [[0, 1, 3, 2], [2, 3, 1, 0]] as GdSeat[][]) m = nextMatch(m, settleHand(m, order));
    expect(m.aAttempts).toEqual([2, 0]);
    expect(m.levelTeam).toBe(0);
    const r = settleHand(m, [1, 0, 2, 3]);
    expect(r).toMatchObject({ team_levels_after: ['2', 'A'], a_attempts: [0, 0], level_team_next: 1 });
  });

  it('scores always sum to zero', () => {
    const rng = createRng('scores');
    for (let i = 0; i < 200; i++) {
      const order = shuffle([0, 1, 2, 3] as GdSeat[], rng);
      const lv = GD_LEVELS[Math.floor(rng() * 13)]!;
      const r = settleHand({ handNo: 2, teamLevels: [lv, 'A'], levelTeam: (i % 2) as 0 | 1, aAttempts: [0, 2], prevOrder: null }, order);
      expect(r.scores.reduce((a, b) => a + b, 0)).toBe(0);
      expect(Math.abs(r.scores[0])).toBe(r.upgrade + (r.match_winner !== null ? 3 : 0));
    }
  });
});

describe('random self-play', () => {
  it('2000 hands through full matches: legal moves validate, cards are conserved, every hand ends', () => {
    const deck = sortCards(fullDeck4());
    let m = newMatch();
    let matches = 0, antis = 0, doubles = 0, jiefeng = 0;
    for (let i = 0; i < 2000; i++) {
      const g = new GuandanGame(`gd-sim-${i}`, m);
      const rng = createRng(`gd-moves-${i}`);
      expect(sortCards(g.initialHands.flat())).toEqual(deck);
      expect(sortCards(g.hands.flat())).toEqual(deck);
      expect(g.level).toBe(m.teamLevels[m.levelTeam]);
      if (g.anti) antis++;
      if (g.tributes.length === 2) doubles++;
      while (g.phase === 'return') {
        const opts = g.returnableCards(g.turn);
        expect(opts.length).toBeGreaterThan(0);
        const auto = g.autoAction();
        g.returnCard(g.turn, rng() < 0.5 && auto.kind === 'return' ? auto.card : opts[Math.floor(rng() * opts.length)]!);
      }
      expect(g.hands.map((h) => h.length).reduce((a, b) => a + b, 0)).toBe(108);
      if (g.tributes.length) expect(g.turn).toBe(g.tributes[0]!.from);
      let steps = 0;
      while (g.phase === 'playing') {
        const seat = g.turn;
        const toBeat = g.toBeat;
        expect(g.hands[seat].length).toBeGreaterThan(0);
        const moves = g.legalMoves();
        if (!toBeat) expect(moves.length).toBeGreaterThan(0);
        const pick = Math.floor(rng() * (moves.length + (toBeat ? 2 : 0)));
        if (pick >= moves.length) {
          const prevLeader = g.lastPlay!.seat;
          expect(g.play(seat, [])).toBeNull();
          if (!g.toBeat && g.turn !== prevLeader) jiefeng++;
        } else {
          const mv = moves[pick]!;
          const before = g.hands[seat].length;
          const p = g.play(seat, mv.cards, rng() < 0.5 ? mv.pattern : undefined);
          expect(p).not.toBeNull();
          if (toBeat) expect(beatsGd(p!, toBeat, g.level)).toBe(true);
          expect(g.hands[seat].length).toBe(before - mv.cards.length);
        }
        if (++steps > 3000) throw new Error('hand did not end');
      }
      const r = g.result!;
      expect([...r.order].sort()).toEqual([0, 1, 2, 3]);
      const out = r.order.filter((s) => g.hands[s].length === 0);
      expect(out.length === 3 || (out.length === 2 && teamOf(out[0]!) === teamOf(out[1]!))).toBe(true);
      expect(r.order.slice(0, out.length)).toEqual(out);
      expect(r.scores.reduce((a, b) => a + b, 0)).toBe(0);
      const played = g.history.flatMap((h) => h.cards);
      expect(sortCards([...g.hands.flat(), ...played])).toEqual(deck);
      if (r.match_winner !== null) matches++;
      m = nextMatch(m, r);
    }
    expect(matches).toBeGreaterThan(0);
    expect(antis).toBeGreaterThan(0);
    expect(doubles).toBeGreaterThan(0);
    expect(jiefeng).toBeGreaterThan(0);
  }, 300_000);
});
