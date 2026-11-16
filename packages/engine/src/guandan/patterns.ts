import type { Card } from '../cards.ts';
import {
  type GdLevel, gdRank, gdRankLabel, gdRankOfLabel, levelRank, rankValue, isWildcard,
  GD_RANK_A, GD_RANK_BJ, GD_RANK_RJ, GD_RANK_SLOTS,
} from './cards.ts';

export type GdPatternType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_pair'
  | 'straight'
  | 'pair_chain'
  | 'plane'
  | 'bomb'
  | 'straight_flush'
  | 'rocket';

export const GD_PATTERN_TYPES: GdPatternType[] = [
  'single', 'pair', 'triple', 'triple_pair', 'straight', 'pair_chain', 'plane', 'bomb', 'straight_flush', 'rocket',
];

export const GD_PATTERN_NAMES: Record<GdPatternType, string> = {
  single: '单张', pair: '对子', triple: '三同张', triple_pair: '三带二', straight: '顺子', pair_chain: '木板',
  plane: '钢板', bomb: '炸弹', straight_flush: '同花顺', rocket: '天王炸',
};

/**
 * Already in API shape. `rank` is a label: the compared card for single/pair/triple/triple_pair/bomb,
 * the top card for sequences (A2345 => "5", TJQKA => "A"), "RJ" for the rocket. `length` is the card
 * count for bomb (4–8) and rocket (4), 1 otherwise. Values depend on the level, so comparisons take it.
 */
export interface GdPattern {
  type: GdPatternType;
  rank: string;
  length: number;
}

/** A requested interpretation: type, optionally with the rank label. */
export interface GdHint {
  type: GdPatternType;
  rank?: string;
}

const SEQUENCE: ReadonlySet<GdPatternType> = new Set(['straight', 'pair_chain', 'plane', 'straight_flush']);

export const isBombLike = (p: GdPattern): boolean => p.type === 'bomb' || p.type === 'straight_flush' || p.type === 'rocket';

/** Bomb class tier: 0 for non-bombs; 4 < 5 < straight flush < 6 < 7 < 8 < rocket. */
function tier(p: GdPattern): number {
  switch (p.type) {
    case 'bomb': return p.length * 2;
    case 'straight_flush': return 11;
    case 'rocket': return 100;
    default: return 0;
  }
}

/** Value within a type: sequence top for chains (A high = 14), single-card value otherwise. */
function value(p: GdPattern, lv: number): number {
  if (p.type === 'rocket') return 0;
  const r = gdRankOfLabel(p.rank);
  return SEQUENCE.has(p.type) ? r : rankValue(r, lv);
}

/** Total order used for auto-choice: bomb tier first, then value. */
export function strength(p: GdPattern, level: GdLevel): number {
  return tier(p) * 100 + value(p, levelRank(level));
}

/** True if `a` beats `b` (b is on the table). Bomb classes beat every non-bomb; non-bombs need the same type. */
export function beatsGd(a: GdPattern, b: GdPattern, level: GdLevel): boolean {
  const ta = tier(a), tb = tier(b);
  const lv = levelRank(level);
  if (ta === 0 && tb === 0) return a.type === b.type && value(a, lv) > value(b, lv);
  if (ta !== tb) return ta > tb;
  return value(a, lv) > value(b, lv);
}

const pat = (type: GdPatternType, rank: number, length = 1): GdPattern => ({ type, rank: gdRankLabel(rank), length });

/**
 * True if the natural ranks in `counts` all fit a sequence of `len` positions ending at `top` (sequence
 * values, A low = 1, A high = 14) with at most `need` cards per position. Wildcards fill the rest: the
 * card total already equals len * need, so fitting is enough.
 */
function fits(counts: number[], top: number, len: number, need: number): boolean {
  const lo = top - len + 1;
  for (let r = 2; r <= GD_RANK_A; r++) {
    const n = counts[r]!;
    if (n === 0) continue;
    const inside = r === GD_RANK_A ? lo === 1 || top === GD_RANK_A : r >= lo && r <= top;
    if (!inside || n > need) return false;
  }
  return true;
}

/** All valid interpretations of `cards` at `level` (empty if invalid). Wildcards may stand for any non-joker. */
export function identifyGd(cards: Card[], level: GdLevel): GdPattern[] {
  const n = cards.length;
  if (n === 0) return [];
  const lv = levelRank(level);
  const counts = new Array<number>(GD_RANK_SLOTS).fill(0);
  let wild = 0;
  for (const c of cards) {
    if (isWildcard(c, level)) wild++;
    else counts[gdRank(c)]!++;
  }
  // Wildcards played on their own are just level cards.
  if (wild === n) {
    counts[lv] = wild;
    wild = 0;
  }
  const jokers = counts[GD_RANK_BJ]! + counts[GD_RANK_RJ]!;
  const ranks: number[] = [];
  for (let r = 2; r < GD_RANK_SLOTS; r++) if (counts[r]! > 0) ranks.push(r);

  if (n === 1) return [pat('single', ranks[0]!)];
  if (n === 4 && counts[GD_RANK_BJ] === 2 && counts[GD_RANK_RJ] === 2) return [pat('rocket', GD_RANK_RJ, 4)];

  const out: GdPattern[] = [];
  if (ranks.length === 1) {
    const r = ranks[0]!;
    // Joker pairs must be natural (a wildcard cannot be a joker); jokers never form triples or bombs.
    if (n === 2 && (r < GD_RANK_BJ || wild === 0)) out.push(pat('pair', r));
    if (r < GD_RANK_BJ) {
      if (n === 3) out.push(pat('triple', r));
      if (n >= 4 && n <= 8) out.push(pat('bomb', r, n));
    }
  }

  if (n === 5) {
    // Triple + pair of another rank; the pair may be BJ BJ / RJ RJ only when both are natural.
    for (let t = 2; t <= GD_RANK_A; t++) {
      if (counts[t]! > 3) continue;
      for (let p = 2; p <= GD_RANK_RJ; p++) {
        if (p === t || counts[p]! > 2) continue;
        if (p >= GD_RANK_BJ && counts[p] !== 2) continue;
        // Every natural card must belong to the triple or the pair.
        if (counts[t]! + counts[p]! + wild !== 5) continue;
        out.push(pat('triple_pair', t));
        break;
      }
    }
    if (jokers === 0) {
      const suits = new Set(cards.filter((c) => !isWildcard(c, level)).map((c) => c[1]));
      for (let top = 5; top <= GD_RANK_A; top++) {
        if (!fits(counts, top, 5, 1)) continue;
        out.push(pat('straight', top));
        if (suits.size <= 1) out.push(pat('straight_flush', top));
      }
    }
  }

  if (n === 6 && jokers === 0) {
    for (let top = 3; top <= GD_RANK_A; top++) if (fits(counts, top, 3, 2)) out.push(pat('pair_chain', top));
    for (let top = 2; top <= GD_RANK_A; top++) if (fits(counts, top, 2, 3)) out.push(pat('plane', top));
  }
  return out;
}

export interface GdResolved {
  ok: true;
  pattern: GdPattern;
}
export interface GdRejected {
  ok: false;
  code: 'INVALID_PATTERN' | 'PATTERN_MISMATCH' | 'CANNOT_BEAT';
  message: string;
}

/** Highest-strength interpretation (leading preference); ties go to the earlier type in GD_PATTERN_TYPES. */
export function preferredGd(patterns: GdPattern[], level: GdLevel): GdPattern | undefined {
  return [...patterns].sort((a, b) => strength(b, level) - strength(a, level)
    || GD_PATTERN_TYPES.indexOf(a.type) - GD_PATTERN_TYPES.indexOf(b.type))[0];
}

/**
 * Chooses the interpretation of `cards` to use. With `hint`, only interpretations of that type (and
 * rank, if given) count. Following `toBeat`: the weakest interpretation that beats it. Leading: the
 * strongest (bombs first, bigger first; then higher rank).
 */
export function resolveGd(cards: Card[], toBeat: GdPattern | null, level: GdLevel, hint?: GdHint): GdResolved | GdRejected {
  const all = identifyGd(cards, level);
  if (all.length === 0) return { ok: false, code: 'INVALID_PATTERN', message: 'cards do not form a valid pattern' };
  const cand = hint ? all.filter((p) => p.type === hint.type && (hint.rank === undefined || p.rank === hint.rank)) : all;
  if (cand.length === 0) {
    const want = hint!.rank === undefined ? hint!.type : `${hint!.type}(${hint!.rank})`;
    return { ok: false, code: 'PATTERN_MISMATCH', message: `cards cannot be played as ${want}; possible: ${all.map(describeGd).join(', ')}` };
  }
  if (!toBeat) return { ok: true, pattern: preferredGd(cand, level)! };
  const winners = cand.filter((p) => beatsGd(p, toBeat, level));
  if (winners.length === 0) {
    return { ok: false, code: 'CANNOT_BEAT', message: `${describeGd(cand[0]!)} cannot beat ${describeGd(toBeat)}` };
  }
  return { ok: true, pattern: winners.sort((a, b) => strength(a, level) - strength(b, level))[0]! };
}

export function describeGd(p: GdPattern): string {
  return p.type === 'bomb' ? `bomb(${p.rank}x${p.length})` : p.type === 'rocket' ? 'rocket' : `${p.type}(${p.rank})`;
}
