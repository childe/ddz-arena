// Best-5-of-N poker hand evaluator (N = 5..7).
// A score is a single integer: category << 20 | five 4-bit rank kickers, so a
// higher score always means a stronger hand and equal scores are exact ties.
import type { Card } from '../cards.ts';
import { holdemCardIndex, holdemCardFromIndex } from './cards.ts';

export const HOLDEM_HAND_NAMES = [
  'high_card',
  'pair',
  'two_pair',
  'three_of_a_kind',
  'straight',
  'flush',
  'full_house',
  'four_of_a_kind',
  'straight_flush',
] as const;

export type HoldemHandRank = (typeof HOLDEM_HAND_NAMES)[number];

export interface HoldemHandValue {
  score: number;
  rank: HoldemHandRank;
  /** The best five cards, most significant first (e.g. trips before kickers; wheel ace last). */
  best: Card[];
}

// STRAIGHT_HIGH[rankMask] = top rank of the highest straight in the mask, or -1.
const STRAIGHT_HIGH = new Int8Array(1 << 13).fill(-1);
for (let m = 0; m < 1 << 13; m++) {
  for (let hi = 12; hi >= 3; hi--) {
    const need = hi === 3 ? 0b1000000001111 : 0b11111 << (hi - 4);
    if ((m & need) === need) {
      STRAIGHT_HIGH[m] = hi;
      break;
    }
  }
}

const counts = new Uint8Array(13);

function topBits(mask: number, n: number, score: number): number {
  for (let r = 12; r >= 0 && n > 0; r--) {
    if (mask & (1 << r)) {
      score = (score << 4) | r;
      n--;
    }
  }
  while (n-- > 0) score <<= 4;
  return score;
}

/** Score card indices (rank * 4 + suit), 5 to 7 of them. Hot path: no allocation. */
export function holdemScoreIndices(cards: ArrayLike<number>, n: number = cards.length): number {
  counts.fill(0);
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i]!;
    const r = c >> 2;
    const bit = 1 << r;
    counts[r]!++;
    rankMask |= bit;
    switch (c & 3) {
      case 0: s0 |= bit; c0++; break;
      case 1: s1 |= bit; c1++; break;
      case 2: s2 |= bit; c2++; break;
      default: s3 |= bit; c3++;
    }
  }
  const flushMask = c0 >= 5 ? s0 : c1 >= 5 ? s1 : c2 >= 5 ? s2 : c3 >= 5 ? s3 : 0;
  if (flushMask) {
    const sh = STRAIGHT_HIGH[flushMask]!;
    if (sh >= 0) return (8 << 20) | (sh << 16);
  }
  let quad = -1, trip1 = -1, trip2 = -1, pair1 = -1, pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = counts[r]!;
    if (k === 4) quad = r;
    else if (k === 3) {
      if (trip1 < 0) trip1 = r;
      else if (trip2 < 0) trip2 = r;
    } else if (k === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }
  if (quad >= 0) return topBits(rankMask & ~(1 << quad), 1, (7 << 4) | quad) << 12;
  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) {
    const p = trip2 > pair1 ? trip2 : pair1;
    return (6 << 20) | (trip1 << 16) | (p << 12);
  }
  if (flushMask) return topBits(flushMask, 5, 5);
  const sh = STRAIGHT_HIGH[rankMask]!;
  if (sh >= 0) return (4 << 20) | (sh << 16);
  if (trip1 >= 0) return topBits(rankMask & ~(1 << trip1), 2, (3 << 4) | trip1) << 8;
  if (pair2 >= 0) {
    return topBits(rankMask & ~(1 << pair1) & ~(1 << pair2), 1, (((2 << 4) | pair1) << 4) | pair2) << 8;
  }
  if (pair1 >= 0) return topBits(rankMask & ~(1 << pair1), 3, (1 << 4) | pair1) << 4;
  return topBits(rankMask, 5, 0);
}

function toIndices(cards: Card[]): number[] {
  if (cards.length < 5 || cards.length > 7) throw new RangeError('need 5 to 7 cards');
  const idx = cards.map(holdemCardIndex);
  if (idx.some((i) => i < 0)) throw new RangeError(`invalid card in ${cards.join(' ')}`);
  if (new Set(idx).size !== idx.length) throw new RangeError(`duplicate card in ${cards.join(' ')}`);
  return idx;
}

/** Score of the best 5-card hand among 5..7 cards. Higher is better. */
export function holdemHandScore(cards: Card[]): number {
  return holdemScoreIndices(toIndices(cards));
}

export function holdemScoreRank(score: number): HoldemHandRank {
  return HOLDEM_HAND_NAMES[score >> 20]!;
}

/** Positive when a beats b, negative when b beats a, 0 for a tie. */
export function compareHoldemHands(a: Card[], b: Card[]): number {
  return holdemHandScore(a) - holdemHandScore(b);
}

/** Full evaluation including which five cards make the hand. */
export function evaluateHoldem(cards: Card[]): HoldemHandValue {
  const idx = toIndices(cards);
  const score = holdemScoreIndices(idx);
  let best = idx.slice(0, 5);
  if (idx.length > 5) {
    const n = idx.length;
    const pick = [0, 0, 0, 0, 0];
    search: for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) {
              pick[0] = idx[a]!; pick[1] = idx[b]!; pick[2] = idx[c]!; pick[3] = idx[d]!; pick[4] = idx[e]!;
              if (holdemScoreIndices(pick, 5) === score) {
                best = pick.slice();
                break search;
              }
            }
  }
  const cat = score >> 20;
  const wheel = (cat === 4 || cat === 8) && ((score >> 16) & 15) === 3;
  const cnt = new Map<number, number>();
  for (const i of best) cnt.set(i >> 2, (cnt.get(i >> 2) ?? 0) + 1);
  const key = (i: number) => {
    const r = i >> 2;
    const rr = wheel && r === 12 ? -1 : r;
    return cnt.get(r)! * 100 + rr;
  };
  best.sort((x, y) => key(y) - key(x) || (x & 3) - (y & 3));
  return { score, rank: holdemScoreRank(score), best: best.map(holdemCardFromIndex) };
}
