import { type Card, rankCounts, rankOf, sortCards, RANK_A, RANK_BJ, RANK_RJ, RANK_COUNT } from '../cards.ts';
import { type Pattern4, type PatternType4, identify4, beats4 } from './patterns4.ts';

export interface Move4 {
  cards: Card[];
  pattern: Pattern4;
}

/**
 * Calls `cb` with every multiset of size k drawn from ranks where avail[r] is how many units rank r can
 * contribute (ranks in ascending order). Callback-based so large wing sets are never materialised at once.
 */
function eachMultiset(avail: number[], k: number, cb: (ranks: number[]) => void): void {
  const cur: number[] = [];
  const rec = (from: number, left: number) => {
    if (left === 0) { cb(cur); return; }
    for (let r = from; r < avail.length; r++) {
      if (avail[r]! <= 0) continue;
      avail[r]!--;
      cur.push(r);
      rec(r, left - 1);
      cur.pop();
      avail[r]!++;
    }
  };
  rec(0, k);
}

/** Calls `cb` with every k-subset of `items` (ascending). */
function eachCombination(items: number[], k: number, cb: (picked: number[]) => void): void {
  const cur: number[] = [];
  const rec = (from: number) => {
    if (cur.length === k) { cb(cur); return; }
    for (let i = from; i <= items.length - (k - cur.length); i++) {
      cur.push(items[i]!);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
}

const rep = (r: number, n: number) => new Array<number>(n).fill(r);

/**
 * Enumerates every distinct legal play from `hand` (by rank multiset, concrete suits chosen lowest-first).
 * With `last`, only plays that beat it are returned; passing is not included.
 */
export function legalMoves4(hand: Card[], last: Pattern4 | null): Move4[] {
  const c = rankCounts(hand);
  // Cards of each rank in suit order, so a rank multiset maps to concrete cards without re-sorting the hand.
  const byRank: Card[][] = Array.from({ length: RANK_COUNT }, () => []);
  for (const card of sortCards(hand)) byRank[rankOf(card)]!.push(card);
  const found = new Map<string, Move4>();

  /** `ranks` must be ascending. */
  const add = (type: PatternType4, main: number, length: number, ranks: number[]) => {
    const pattern: Pattern4 = { type, main, length };
    if (last && !beats4(pattern, last)) return;
    const key = `${type}:${main}:${ranks.join(',')}`;
    if (found.has(key)) return;
    const cards: Card[] = [];
    for (let i = 0; i < ranks.length; ) {
      const r = ranks[i]!;
      let j = i;
      while (j < ranks.length && ranks[j] === r) j++;
      cards.push(...byRank[r]!.slice(0, j - i));
      i = j;
    }
    // Guard against generator/identifier drift: the play must be recognised as this exact pattern.
    if (!identify4(cards).some((p) => p.type === type && p.main === main && p.length === length)) return;
    found.set(key, { cards, pattern });
  };

  // Restrict generation to the needed type when following, except bombs/rocket which always apply.
  const want = (t: PatternType4) => !last || last.type === t || t === 'bomb' || t === 'rocket';
  const chainLen = (t: PatternType4, l: number) => !last || last.type !== t || last.length === l;

  for (let r = 0; r < c.length; r++) {
    const n = c[r]!;
    if (n >= 1 && want('single')) add('single', r, 1, [r]);
    if (n >= 2 && want('pair')) add('pair', r, 1, rep(r, 2));
    if (n >= 3 && want('triple')) add('triple', r, 1, rep(r, 3));
    if (r < RANK_BJ && want('bomb')) for (let k = 4; k <= n; k++) add('bomb', r, k, rep(r, k));
  }
  if (c[RANK_BJ] === 2 && c[RANK_RJ] === 2) add('rocket', RANK_RJ, 4, [RANK_BJ, RANK_BJ, RANK_RJ, RANK_RJ]);

  const sortedPlus = (body: number[], wings: number[]) => [...body, ...wings].sort((a, b) => a - b);
  for (let t = 0; t < RANK_BJ; t++) {
    if (c[t]! < 3) continue;
    if (want('triple_single')) {
      for (let k = 0; k < c.length; k++) if (k !== t && c[k]! >= 1) add('triple_single', t, 1, sortedPlus(rep(t, 3), [k]));
    }
    if (want('triple_pair')) {
      for (let p = 0; p < c.length; p++) if (p !== t && c[p]! >= 2) add('triple_pair', t, 1, sortedPlus(rep(t, 3), [p, p]));
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
  if (want('pair_chain')) chains(2, 3, 12, (s, l) => chainLen('pair_chain', l) && add('pair_chain', s, l, chainRanks(s, l, 2)));
  if (want('plane')) chains(3, 2, 12, (s, l) => chainLen('plane', l) && add('plane', s, l, chainRanks(s, l, 3)));

  if (want('plane_single')) {
    chains(3, 2, 12, (s, l) => {
      if (!chainLen('plane_single', l) || hand.length < l * 4) return;
      const body = chainRanks(s, l, 3);
      // Kickers come from non-body ranks; all four jokers together are not allowed as kickers.
      const avail = c.map((n, r) => (r >= s && r < s + l ? 0 : n));
      eachMultiset(avail, l, (kick) => {
        if (l >= 4 && kick.filter((r) => r >= RANK_BJ).length === 4) return;
        add('plane_single', s, l, sortedPlus(body, kick));
      });
    });
  }
  if (want('plane_pair')) {
    chains(3, 2, 12, (s, l) => {
      if (!chainLen('plane_pair', l) || hand.length < l * 5) return;
      const body = chainRanks(s, l, 3);
      const pairRanks: number[] = [];
      for (let r = 0; r < c.length; r++) if ((r < s || r >= s + l) && c[r]! >= 2) pairRanks.push(r);
      eachCombination(pairRanks, l, (picked) => {
        if (picked.includes(RANK_BJ) && picked.includes(RANK_RJ)) return;
        add('plane_pair', s, l, sortedPlus(body, picked.flatMap((r) => [r, r])));
      });
    });
  }
  return [...found.values()];
}
