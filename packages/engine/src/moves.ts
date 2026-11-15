import { type Card, rankCounts, pickByRanks, RANK_A, RANK_BJ, RANK_RJ } from './cards.ts';
import { type Pattern, type PatternType, identify, beats } from './patterns.ts';

export interface Move {
  cards: Card[];
  pattern: Pattern;
}

/** All multisets of size k drawn from ranks where avail[r] is how many units rank r can contribute. */
function multisets(avail: number[], k: number, from = 0): number[][] {
  if (k === 0) return [[]];
  const out: number[][] = [];
  for (let r = from; r < avail.length; r++) {
    if (avail[r]! <= 0) continue;
    avail[r]!--;
    for (const rest of multisets(avail, k - 1, r)) out.push([r, ...rest]);
    avail[r]!++;
  }
  return out;
}

const rep = (r: number, n: number) => new Array<number>(n).fill(r);

/**
 * Enumerates every distinct legal play from `hand` (by rank multiset, concrete suits chosen lowest-first).
 * With `last`, only plays that beat it are returned; passing is not included.
 */
export function legalMoves(hand: Card[], last: Pattern | null): Move[] {
  const c = rankCounts(hand);
  const found = new Map<string, Move>();

  const add = (type: PatternType, main: number, length: number, ranks: number[]) => {
    const pattern: Pattern = { type, main, length };
    if (last && !beats(pattern, last)) return;
    const sorted = [...ranks].sort((a, b) => a - b);
    const key = `${type}:${main}:${sorted.join(',')}`;
    if (found.has(key)) return;
    const cards = pickByRanks(hand, sorted);
    // Guard against generator/identifier drift: the play must be recognised as this exact pattern.
    if (!identify(cards).some((p) => p.type === type && p.main === main && p.length === length)) return;
    found.set(key, { cards, pattern });
  };

  // Restrict generation to the needed type when following, except bombs/rocket which always apply.
  const want = (t: PatternType) => !last || last.type === t || t === 'bomb' || t === 'rocket';
  const chainLen = (t: PatternType, l: number) => !last || last.type !== t || last.length === l;

  for (let r = 0; r < c.length; r++) {
    const n = c[r]!;
    if (n >= 1 && want('single')) add('single', r, 1, [r]);
    if (n >= 2 && r < RANK_BJ && want('pair')) add('pair', r, 1, rep(r, 2));
    if (n >= 3 && want('triple')) add('triple', r, 1, rep(r, 3));
    if (n === 4 && want('bomb')) add('bomb', r, 1, rep(r, 4));
  }
  if (c[RANK_BJ] === 1 && c[RANK_RJ] === 1) add('rocket', RANK_RJ, 1, [RANK_BJ, RANK_RJ]);

  for (let t = 0; t < c.length; t++) {
    if (c[t]! < 3) continue;
    if (want('triple_single')) {
      for (let k = 0; k < c.length; k++) if (k !== t && c[k]! >= 1) add('triple_single', t, 1, [...rep(t, 3), k]);
    }
    if (want('triple_pair')) {
      for (let p = 0; p < RANK_BJ; p++) if (p !== t && c[p]! >= 2) add('triple_pair', t, 1, [...rep(t, 3), p, p]);
    }
  }

  const chains = (need: number, minLen: number, maxLen: number, cb: (s: number, len: number) => void) => {
    for (let len = minLen; len <= maxLen; len++) {
      for (let s = 0; s + len - 1 <= RANK_A; s++) {
        let ok = true;
        for (let r = s; r < s + len; r++) if (c[r]! < need) { ok = false; break; }
        if (ok) cb(s, len);
      }
    }
  };
  const chainRanks = (s: number, len: number, times: number) => {
    const out: number[] = [];
    for (let r = s; r < s + len; r++) out.push(...rep(r, times));
    return out;
  };

  if (want('straight')) chains(1, 5, 12, (s, l) => chainLen('straight', l) && add('straight', s, l, chainRanks(s, l, 1)));
  if (want('pair_chain')) chains(2, 3, 10, (s, l) => chainLen('pair_chain', l) && add('pair_chain', s, l, chainRanks(s, l, 2)));
  if (want('plane')) chains(3, 2, 6, (s, l) => chainLen('plane', l) && add('plane', s, l, chainRanks(s, l, 3)));

  if (want('plane_single')) {
    chains(3, 2, 5, (s, l) => {
      if (!chainLen('plane_single', l) || hand.length < l * 4) return;
      const avail = c.map((n, r) => (r >= s && r < s + l ? 0 : n));
      for (const kick of multisets(avail, l)) add('plane_single', s, l, [...chainRanks(s, l, 3), ...kick]);
    });
  }
  if (want('plane_pair')) {
    chains(3, 2, 4, (s, l) => {
      if (!chainLen('plane_pair', l) || hand.length < l * 5) return;
      const avail = c.map((n, r) => (r >= s && r < s + l) || r >= RANK_BJ ? 0 : Math.floor(n / 2));
      for (const kick of multisets(avail, l)) add('plane_pair', s, l, [...chainRanks(s, l, 3), ...kick.flatMap((r) => [r, r])]);
    });
  }
  for (let f = 0; f < c.length; f++) {
    if (c[f] !== 4) continue;
    if (want('four_two_single')) {
      const avail = c.map((n, r) => (r === f ? 0 : n));
      for (const kick of multisets(avail, 2)) add('four_two_single', f, 1, [...rep(f, 4), ...kick]);
    }
    if (want('four_two_pair')) {
      const avail = c.map((n, r) => (r === f || r >= RANK_BJ ? 0 : Math.floor(n / 2)));
      for (const kick of multisets(avail, 2)) add('four_two_pair', f, 1, [...rep(f, 4), ...kick.flatMap((r) => [r, r])]);
    }
  }
  return [...found.values()];
}

/** The play a timed-out or trustee seat makes when it must lead: the lowest single. */
export function lowestSingle(hand: Card[]): Card[] {
  const c = rankCounts(hand);
  const r = c.findIndex((n) => n > 0);
  return pickByRanks(hand, [r]);
}
