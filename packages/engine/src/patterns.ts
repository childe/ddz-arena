import { type Card, rankCounts, RANK_A, RANK_BJ, RANK_RJ, RANK_LABELS } from './cards.ts';

export type PatternType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_single'
  | 'triple_pair'
  | 'straight'
  | 'pair_chain'
  | 'plane'
  | 'plane_single'
  | 'plane_pair'
  | 'four_two_single'
  | 'four_two_pair'
  | 'bomb'
  | 'rocket';

export const PATTERN_TYPES: PatternType[] = [
  'single', 'pair', 'triple', 'triple_single', 'triple_pair', 'straight', 'pair_chain',
  'plane', 'plane_single', 'plane_pair', 'four_two_single', 'four_two_pair', 'bomb', 'rocket',
];

export const PATTERN_NAMES: Record<PatternType, string> = {
  single: '单张', pair: '对子', triple: '三张', triple_single: '三带一', triple_pair: '三带一对',
  straight: '顺子', pair_chain: '连对', plane: '飞机', plane_single: '飞机带单', plane_pair: '飞机带对',
  four_two_single: '四带二', four_two_pair: '四带两对', bomb: '炸弹', rocket: '王炸',
};

export interface Pattern {
  type: PatternType;
  /** Rank value used for comparison: the lowest rank of the main body for chains. */
  main: number;
  /** Chain length (number of distinct main ranks); 1 for non-chains. */
  length: number;
}

/** Start ranks of every run of `len` consecutive ranks (all <= A) whose counts equal (or reach) `need`. */
function runs(counts: number[], need: number, exact: boolean, len: number): number[] {
  const starts: number[] = [];
  for (let s = 0; s + len - 1 <= RANK_A; s++) {
    let ok = true;
    for (let r = s; r < s + len; r++) {
      const c = counts[r]!;
      if (exact ? c !== need : c < need) { ok = false; break; }
    }
    if (ok) starts.push(s);
  }
  return starts;
}

/** All valid interpretations of `cards` as a pattern (empty if invalid). */
export function identify(cards: Card[]): Pattern[] {
  const n = cards.length;
  if (n === 0) return [];
  const counts = rankCounts(cards);
  const distinct = counts.filter((c) => c > 0).length;
  const out: Pattern[] = [];
  const maxRank = (k: number) => counts.findIndex((c) => c === k);

  if (n === 1) return [{ type: 'single', main: maxRank(1), length: 1 }];
  if (n === 2) {
    if (counts[RANK_BJ] === 1 && counts[RANK_RJ] === 1) return [{ type: 'rocket', main: RANK_RJ, length: 1 }];
    if (distinct === 1) return [{ type: 'pair', main: maxRank(2), length: 1 }];
    return [];
  }
  if (n === 3 && distinct === 1) return [{ type: 'triple', main: maxRank(3), length: 1 }];
  if (n === 4) {
    if (distinct === 1) return [{ type: 'bomb', main: maxRank(4), length: 1 }];
    if (distinct === 2 && counts.includes(3)) return [{ type: 'triple_single', main: maxRank(3), length: 1 }];
    return [];
  }
  if (n === 5 && distinct === 2 && counts.includes(3) && counts.includes(2)) {
    out.push({ type: 'triple_pair', main: maxRank(3), length: 1 });
  }

  // straight
  if (n >= 5 && distinct === n) {
    const s = runs(counts, 1, true, n);
    if (s.length) out.push({ type: 'straight', main: s[0]!, length: n });
  }
  // pair chain
  if (n >= 6 && n % 2 === 0 && distinct === n / 2) {
    const s = runs(counts, 2, true, n / 2);
    if (s.length) out.push({ type: 'pair_chain', main: s[0]!, length: n / 2 });
  }
  // plane without wings
  if (n >= 6 && n % 3 === 0 && distinct === n / 3) {
    const s = runs(counts, 3, true, n / 3);
    if (s.length) out.push({ type: 'plane', main: s[0]!, length: n / 3 });
  }
  // plane with single wings: k triples + k kickers. Triple ranks must have exactly 3 cards
  // (a 4th card of the same rank may not be a kicker); kickers may not be both jokers.
  if (n >= 8 && n % 4 === 0) {
    const k = n / 4;
    for (const s of runs(counts, 3, true, k)) {
      if (counts[RANK_BJ] === 1 && counts[RANK_RJ] === 1) break;
      out.push({ type: 'plane_single', main: s, length: k });
    }
  }
  // plane with pair wings: k triples + k pairs (a four of a kind counts as two pairs; jokers can't pair).
  if (n >= 10 && n % 5 === 0) {
    const k = n / 5;
    for (const s of runs(counts, 3, true, k)) {
      let ok = true;
      for (let r = 0; r < counts.length; r++) {
        if (r >= s && r < s + k) continue;
        if (counts[r]! % 2 !== 0 || (r >= RANK_BJ && counts[r]! > 0)) { ok = false; break; }
      }
      if (ok) out.push({ type: 'plane_pair', main: s, length: k });
    }
  }
  // four with two singles / two pairs
  if (n === 6) {
    const f = maxRank(4);
    if (f >= 0 && !(counts[RANK_BJ] === 1 && counts[RANK_RJ] === 1)) out.push({ type: 'four_two_single', main: f, length: 1 });
  }
  if (n === 8) {
    for (let f = 0; f < counts.length; f++) {
      if (counts[f] !== 4) continue;
      let ok = true;
      for (let r = 0; r < counts.length; r++) {
        if (r === f) continue;
        if (counts[r]! % 2 !== 0 || (r >= RANK_BJ && counts[r]! > 0)) { ok = false; break; }
      }
      if (ok) out.push({ type: 'four_two_pair', main: f, length: 1 });
    }
  }
  return out;
}

/** Interpretation preference when leading: bigger main body first, then higher main rank. */
function bodySize(p: Pattern): number {
  switch (p.type) {
    case 'rocket': return 100;
    case 'bomb': return 99;
    case 'plane': case 'plane_single': case 'plane_pair': return p.length * 3;
    case 'pair_chain': return p.length * 2;
    case 'straight': return p.length;
    case 'four_two_single': case 'four_two_pair': return 4;
    default: return 3;
  }
}

export function preferred(patterns: Pattern[]): Pattern | undefined {
  return [...patterns].sort((a, b) => bodySize(b) - bodySize(a) || b.main - a.main)[0];
}

/** True if pattern `a` beats pattern `b` (b is the play on the table). */
export function beats(a: Pattern, b: Pattern): boolean {
  if (a.type === 'rocket') return true;
  if (b.type === 'rocket') return false;
  if (a.type === 'bomb' && b.type !== 'bomb') return true;
  if (a.type !== b.type || a.length !== b.length) return false;
  return a.main > b.main;
}

export interface Resolved {
  ok: true;
  pattern: Pattern;
}
export interface Rejected {
  ok: false;
  code: 'INVALID_PATTERN' | 'CANNOT_BEAT';
  message: string;
}

/**
 * Chooses the interpretation of `cards` to use. With `last` (a play to beat), picks an interpretation
 * that beats it; with `hint`, restricts to that pattern type.
 */
export function resolve(cards: Card[], last: Pattern | null, hint?: PatternType): Resolved | Rejected {
  let all = identify(cards);
  if (hint) all = all.filter((p) => p.type === hint);
  if (all.length === 0) {
    return { ok: false, code: 'INVALID_PATTERN', message: hint ? `cards do not form a ${hint}` : 'cards do not form a valid pattern' };
  }
  if (!last) return { ok: true, pattern: preferred(all)! };
  const winners = all.filter((p) => beats(p, last));
  if (winners.length === 0) {
    return { ok: false, code: 'CANNOT_BEAT', message: `${describe(all[0]!)} cannot beat ${describe(last)}` };
  }
  return { ok: true, pattern: preferred(winners)! };
}

export function describe(p: Pattern): string {
  const r = RANK_LABELS[p.main];
  return p.length > 1 ? `${p.type}(${r}x${p.length})` : `${p.type}(${r})`;
}
