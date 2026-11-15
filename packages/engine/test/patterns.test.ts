import { describe, it, expect } from 'vitest';
import { identify, resolve, beats, type Pattern, type PatternType } from '../src/index.ts';

// Short notation: ranks only, suits auto-assigned. "X" small joker, "D" big joker.
function cards(s: string): string[] {
  const used: Record<string, number> = {};
  return s.split('').filter((ch) => ch !== ' ').map((ch) => {
    if (ch === 'X') return 'BJ';
    if (ch === 'D') return 'RJ';
    const i = used[ch] ?? 0;
    used[ch] = i + 1;
    return ch + 'SHCD'[i];
  });
}
const types = (s: string) => identify(cards(s)).map((p) => p.type).sort();

describe('identify', () => {
  const valid: [string, PatternType[]][] = [
    ['3', ['single']],
    ['D', ['single']],
    ['33', ['pair']],
    ['XD', ['rocket']],
    ['222', ['triple']],
    ['3333', ['bomb']],
    ['3334', ['triple_single']],
    ['333X', ['triple_single']],
    ['33344', ['triple_pair']],
    ['34567', ['straight']],
    ['3456789TJQKA', ['straight']],
    ['334455', ['pair_chain']],
    ['333444', ['plane']],
    ['33344456', ['plane_single']],
    ['33344455', ['plane_single']],
    ['3334445566', ['plane_pair']],
    ['3334445555', ['plane_pair']],
    ['333345', ['four_two_single']],
    ['333355', ['four_two_single']],
    ['33334455', ['four_two_pair']],
    ['333444555666', ['plane', 'plane_single', 'plane_single'].sort() as PatternType[]],
    ['44445555', ['four_two_pair', 'four_two_pair']],
  ];
  for (const [s, t] of valid) it(`${s} -> ${t.join(',')}`, () => expect(types(s)).toEqual(t));

  const invalid = ['34', '3344', '33445', '3456', 'JQKA2', 'QKA23', '33XD', '2233', '22AAKK', '333444XD',
    '334455X', '3333XD', '333444555XD', '3334446', '333XD', '3333444455XD'];
  for (const s of invalid) it(`${s} is invalid`, () => expect(types(s)).toEqual([]));

  it('33334444 is four_two_pair (four with two pairs) only', () => {
    expect(types('33334444')).toEqual(['four_two_pair', 'four_two_pair']);
  });
  it('2 and jokers cannot be in chains', () => {
    expect(types('TJQKA2')).toEqual([]);
    expect(types('KKAA22')).toEqual([]);
    expect(types('AAA222')).toEqual([]);
  });
  it('a fourth card of a plane rank cannot be a wing', () => {
    expect(types('33334445')).toEqual([]);
  });
});

describe('beats', () => {
  const p = (s: string): Pattern => resolve(cards(s), null).ok ? (resolve(cards(s), null) as { pattern: Pattern }).pattern : (() => { throw new Error(s); })();
  it('higher single beats lower', () => {
    expect(beats(p('4'), p('3'))).toBe(true);
    expect(beats(p('2'), p('A'))).toBe(true);
    expect(beats(p('X'), p('2'))).toBe(true);
    expect(beats(p('D'), p('X'))).toBe(true);
    expect(beats(p('3'), p('3'))).toBe(false);
  });
  it('different type or length cannot beat', () => {
    expect(beats(p('44'), p('3'))).toBe(false);
    expect(beats(p('456789'), p('34567'))).toBe(false);
    expect(beats(p('45678'), p('34567'))).toBe(true);
  });
  it('bombs and rocket', () => {
    expect(beats(p('3333'), p('22'))).toBe(true);
    expect(beats(p('3333'), p('3456789TJQKA'))).toBe(true);
    expect(beats(p('4444'), p('3333'))).toBe(true);
    expect(beats(p('3333'), p('4444'))).toBe(false);
    expect(beats(p('XD'), p('2222'))).toBe(true);
    expect(beats(p('2222'), p('XD'))).toBe(false);
  });
});

describe('resolve', () => {
  it('prefers the longest plane when leading', () => {
    const r = resolve(cards('333444555666'), null);
    expect(r.ok && r.pattern).toMatchObject({ type: 'plane', length: 4 });
  });
  it('chooses the interpretation that beats the table', () => {
    const last: Pattern = { type: 'plane_single', main: 0, length: 3 };
    const r = resolve(cards('444555666777'), last);
    expect(r.ok && r.pattern).toMatchObject({ type: 'plane_single', main: 2, length: 3 });
  });
  it('respects a pattern hint', () => {
    const r = resolve(cards('333444555666'), null, 'plane_single');
    expect(r.ok && r.pattern).toMatchObject({ type: 'plane_single', main: 1 });
  });
  it('reports CANNOT_BEAT and INVALID_PATTERN', () => {
    expect(resolve(cards('33'), { type: 'pair', main: 5, length: 1 })).toMatchObject({ ok: false, code: 'CANNOT_BEAT' });
    expect(resolve(cards('34'), null)).toMatchObject({ ok: false, code: 'INVALID_PATTERN' });
  });
});
