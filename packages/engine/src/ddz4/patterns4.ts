import { type Card, rankCounts, RANK_A, RANK_BJ, RANK_RJ, RANK_LABELS } from '../cards.ts';

export type PatternType4 =
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
  | 'bomb'
  | 'rocket';

export const PATTERN_TYPES4: PatternType4[] = [
  'single', 'pair', 'triple', 'triple_single', 'triple_pair', 'straight', 'pair_chain',
  'plane', 'plane_single', 'plane_pair', 'bomb', 'rocket',
];

export const PATTERN_NAMES4: Record<PatternType4, string> = {
  single: '单张', pair: '对子', triple: '三张', triple_single: '三带一', triple_pair: '三带一对',
  straight: '顺子', pair_chain: '连对', plane: '飞机', plane_single: '飞机带单', plane_pair: '飞机带对',
  bomb: '炸弹', rocket: '天王炸',
};

export interface Pattern4 {
  type: PatternType4;
  /** Rank value used for comparison: the lowest rank of the main body for chains. */
  main: number;
  /** Chain length (number of distinct main ranks); number of cards for bomb (4–8) and rocket (4); 1 otherwise. */
  length: number;
}

/** Start ranks of every run of `len` consecutive ranks (all <= A) whose counts are exactly `need`. */
function runs(counts: number[], need: number, len: number): number[] {
  const starts: number[] = [];
  for (let s = 0; s + len - 1 <= RANK_A; s++) {
    let ok = true;
    for (let r = s; r < s + len; r++) {
      if (counts[r] !== need) { ok = false; break; }
    }
    if (ok) starts.push(s);
  }
  return starts;
}

/** All valid interpretations of `cards` as a pattern (empty if invalid). */
export function identify4(cards: Card[]): Pattern4[] {
  const n = cards.length;
  if (n === 0) return [];
  const counts = rankCounts(cards);
  const distinct = counts.filter((c) => c > 0).length;
  const fourJokers = counts[RANK_BJ] === 2 && counts[RANK_RJ] === 2;
  const out: Pattern4[] = [];
  const rankWith = (k: number) => counts.findIndex((c) => c === k);

  if (n === 1) return [{ type: 'single', main: rankWith(1), length: 1 }];
  // BJ BJ and RJ RJ are pairs; BJ RJ is nothing.
  if (n === 2) return distinct === 1 ? [{ type: 'pair', main: rankWith(2), length: 1 }] : [];
  if (n === 3) return distinct === 1 ? [{ type: 'triple', main: rankWith(3), length: 1 }] : [];
  if (n === 4 && fourJokers) return [{ type: 'rocket', main: RANK_RJ, length: 4 }];
  if (distinct === 1 && n <= 8) {
    // 4–8 of one non-joker rank (jokers have at most 2 copies, so they never get here).
    return [{ type: 'bomb', main: rankWith(n), length: n }];
  }
  if (n === 4) {
    return distinct === 2 && counts.includes(3) ? [{ type: 'triple_single', main: rankWith(3), length: 1 }] : [];
  }
  if (n === 5 && distinct === 2 && counts.includes(3) && counts.includes(2)) {
    out.push({ type: 'triple_pair', main: rankWith(3), length: 1 });
  }

  // straight
  if (n >= 5 && distinct === n) {
    const s = runs(counts, 1, n);
    if (s.length) out.push({ type: 'straight', main: s[0]!, length: n });
  }
  // pair chain
  if (n >= 6 && n % 2 === 0 && distinct === n / 2) {
    const s = runs(counts, 2, n / 2);
    if (s.length) out.push({ type: 'pair_chain', main: s[0]!, length: n / 2 });
  }
  // plane without wings
  if (n >= 6 && n % 3 === 0 && distinct === n / 3) {
    const s = runs(counts, 3, n / 3);
    if (s.length) out.push({ type: 'plane', main: s[0]!, length: n / 3 });
  }
  // Plane with single wings: k triples + k kickers. Body ranks have exactly 3 cards (so no kicker shares a
  // body rank); kickers may repeat a rank but may not be all four jokers.
  if (n >= 8 && n % 4 === 0 && !fourJokers) {
    const k = n / 4;
    for (const s of runs(counts, 3, k)) out.push({ type: 'plane_single', main: s, length: k });
  }
  // Plane with pair wings: k triples + k pairs of k different ranks (BJ BJ / RJ RJ allowed, not both).
  if (n >= 10 && n % 5 === 0 && !fourJokers) {
    const k = n / 5;
    for (const s of runs(counts, 3, k)) {
      let ok = true;
      for (let r = 0; r < counts.length; r++) {
        if (r >= s && r < s + k) continue;
        if (counts[r] !== 0 && counts[r] !== 2) { ok = false; break; }
      }
      if (ok) out.push({ type: 'plane_pair', main: s, length: k });
    }
  }
  return out;
}

/** Interpretation preference when leading: bigger main body first, then higher main rank. */
function bodySize(p: Pattern4): number {
  switch (p.type) {
    case 'rocket': return 100;
    case 'bomb': return 99;
    case 'plane': case 'plane_single': case 'plane_pair': return p.length * 3;
    case 'pair_chain': return p.length * 2;
    case 'straight': return p.length;
    default: return 3;
  }
}

export function preferred4(patterns: Pattern4[]): Pattern4 | undefined {
  return [...patterns].sort((a, b) => bodySize(b) - bodySize(a) || b.main - a.main)[0];
}

/**
 * True if pattern `a` beats pattern `b` (b is the play on the table).
 * rocket > 8-card bomb > ... > 4-card bomb (same size: higher rank); any bomb beats every non-bomb.
 */
export function beats4(a: Pattern4, b: Pattern4): boolean {
  if (b.type === 'rocket') return false;
  if (a.type === 'rocket') return true;
  if (a.type === 'bomb') {
    if (b.type !== 'bomb') return true;
    return a.length > b.length || (a.length === b.length && a.main > b.main);
  }
  if (a.type !== b.type || a.length !== b.length) return false;
  return a.main > b.main;
}

export interface Resolved4 {
  ok: true;
  pattern: Pattern4;
}
export interface Rejected4 {
  ok: false;
  code: 'INVALID_PATTERN' | 'CANNOT_BEAT';
  message: string;
}

/**
 * Chooses the interpretation of `cards` to use. With `last` (a play to beat), picks an interpretation
 * that beats it; with `hint`, restricts to that pattern type.
 */
export function resolve4(cards: Card[], last: Pattern4 | null, hint?: PatternType4): Resolved4 | Rejected4 {
  let all = identify4(cards);
  if (hint) all = all.filter((p) => p.type === hint);
  if (all.length === 0) {
    return { ok: false, code: 'INVALID_PATTERN', message: hint ? `cards do not form a ${hint}` : 'cards do not form a valid pattern' };
  }
  if (!last) return { ok: true, pattern: preferred4(all)! };
  const winners = all.filter((p) => beats4(p, last));
  if (winners.length === 0) {
    return { ok: false, code: 'CANNOT_BEAT', message: `${describe4(all[0]!)} cannot beat ${describe4(last)}` };
  }
  return { ok: true, pattern: preferred4(winners)! };
}

export function describe4(p: Pattern4): string {
  const r = RANK_LABELS[p.main];
  return p.length > 1 ? `${p.type}(${r}x${p.length})` : `${p.type}(${r})`;
}
