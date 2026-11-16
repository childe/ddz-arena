// Guandan card values. Same codes and two-deck multisets as ddz4; what changes is the order: the level
// rank is lifted above A for single-card comparisons, and the red-heart level card is a wildcard.
import { type Card, SUITS, SMALL_JOKER, BIG_JOKER } from '../cards.ts';

export type GdLevel = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export const GD_LEVELS: GdLevel[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

// Natural ranks: 2..K => 2..13, A => 14, BJ => 15, RJ => 16. A also sits at 1 in sequences (A2345).
export const GD_RANK_A = 14;
export const GD_RANK_BJ = 15;
export const GD_RANK_RJ = 16;
export const GD_RANK_SLOTS = 17;

const RANK_CHARS = '23456789TJQKA';
const LABELS = ['', '', ...RANK_CHARS.split(''), 'BJ', 'RJ'];

export function isLevel(x: unknown): x is GdLevel {
  return typeof x === 'string' && (GD_LEVELS as string[]).includes(x);
}

/** Natural rank of a card (2..14, BJ 15, RJ 16). */
export function gdRank(c: Card): number {
  if (c === SMALL_JOKER) return GD_RANK_BJ;
  if (c === BIG_JOKER) return GD_RANK_RJ;
  const r = RANK_CHARS.indexOf(c[0]!);
  if (r < 0 || c.length !== 2) throw new Error(`invalid card ${c}`);
  return r + 2;
}

/** Label of a natural rank: "2".."A", "BJ", "RJ". */
export function gdRankLabel(r: number): string {
  const l = LABELS[r];
  if (!l) throw new Error(`invalid rank ${r}`);
  return l;
}

/** Inverse of gdRankLabel (returns -1 for unknown labels). */
export function gdRankOfLabel(label: string): number {
  const i = LABELS.indexOf(label);
  return i < 2 ? -1 : i;
}

export const levelRank = (level: GdLevel): number => RANK_CHARS.indexOf(level) + 2;

/** The wildcard (逢人配) of a level: the red-heart level card, e.g. "7H". Two copies in the deck. */
export const wildcardOf = (level: GdLevel): Card => level + 'H';

export const isWildcard = (c: Card, level: GdLevel): boolean => c === wildcardOf(level);

/**
 * Single-card value of a natural rank: 2 < ... < A < level < BJ < RJ. Used for single, pair, triple,
 * triple_pair and bomb. The level rank becomes 15, jokers 16 and 17.
 */
export function rankValue(r: number, lv: number): number {
  if (r === lv) return 15;
  return r >= GD_RANK_BJ ? r + 1 : r;
}

export const cardValue = (c: Card, level: GdLevel): number => rankValue(gdRank(c), levelRank(level));

const suitIndex = (c: Card) => (c.length === 2 && c[1] !== 'J' ? SUITS.indexOf(c[1]!) : 0);

/** Sorts by single-card value (level cards just below the jokers), then suit S H C D. */
export function sortByValue(cards: Card[], level: GdLevel): Card[] {
  const lv = levelRank(level);
  const key = (c: Card) => rankValue(gdRank(c), lv) * 4 + suitIndex(c);
  return [...cards].sort((a, b) => key(a) - key(b));
}

/** The card with the highest single value, wildcards excluded; ties go to the first suit in S H C D. */
export function highestCard(cards: Card[], level: GdLevel): Card | null {
  const rest = cards.filter((c) => !isWildcard(c, level));
  return rest.length ? sortByValue(rest, level).reduce((best, c) => (cardValue(c, level) > cardValue(best, level) ? c : best)) : null;
}

/** Cards that may be returned after a tribute: natural 2–10, never a joker or the wildcard. */
export function isReturnable(c: Card, level: GdLevel): boolean {
  const r = gdRank(c);
  return r >= 2 && r <= 10 && !isWildcard(c, level);
}
