// Gongzhu (拱猪) cards: one 52-card deck without jokers, same codes as ddz. Within a suit 2 is lowest
// and A highest; suits never beat each other (no trumps).
import { type Card, SUITS } from '../cards.ts';

export type GzSuit = 'S' | 'H' | 'C' | 'D';

const RANK_CHARS = '23456789TJQKA';

export const PIG = 'QS';
export const GOAT = 'JD';
export const TRANSFORMER = 'TC';
export const HEART_ACE = 'AH';
/** Cards that may be exposed (亮牌) before play; each doubles its own effect. */
export const EXPOSABLE: Card[] = [PIG, GOAT, TRANSFORMER, HEART_ACE];

const DECK: Card[] = [];
for (const s of SUITS) for (const r of RANK_CHARS) DECK.push(r + s);
const DECK_SET = new Set(DECK);

export function fullDeckGz(): Card[] {
  return [...DECK];
}

export function isGzCard(c: unknown): c is Card {
  return typeof c === 'string' && DECK_SET.has(c);
}

export const suitOf = (c: Card): GzSuit => c[1] as GzSuit;

/** 2..14 (A high). */
export const gzRank = (c: Card): number => RANK_CHARS.indexOf(c[0]!) + 2;

/** Sorts by suit (S H C D), then rank ascending. */
export function sortGz(cards: Card[]): Card[] {
  const key = (c: Card) => SUITS.indexOf(c[1]!) * 16 + gzRank(c);
  return [...cards].sort((a, b) => key(a) - key(b));
}

/** Heart values before doubling: A −50, K −40, Q −30, J −20, 10..5 −10, 4..2 0. Sum −200. */
export function heartPoints(c: Card): number {
  if (suitOf(c) !== 'H') return 0;
  const r = gzRank(c);
  if (r === 14) return -50;
  if (r >= 11) return -(r - 9) * 10;
  return r >= 5 ? -10 : 0;
}

/** The 16 scoring cards (分牌): all hearts, the pig, the goat and the transformer. */
export const isScoring = (c: Card): boolean => suitOf(c) === 'H' || c === PIG || c === GOAT || c === TRANSFORMER;

export const SCORING_COUNT = 16;
