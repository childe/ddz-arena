// 52-card deck for Texas Hold'em. Codes are rank + suit, e.g. "AS", "TD".
import type { Card } from '../cards.ts';

/** Same string type as the engine-wide Card; aliased to avoid an export name clash. */
export type HoldemCard = Card;

export const HOLDEM_RANKS = '23456789TJQKA';
export const HOLDEM_SUITS = 'SHCD';

/** All 52 cards, rank-major ("2S", "2H", "2C", "2D", "3S", ...). */
export function holdemDeck(): Card[] {
  const out: Card[] = [];
  for (const r of HOLDEM_RANKS) for (const s of HOLDEM_SUITS) out.push(r + s);
  return out;
}

/** Index 0..51 = rank * 4 + suit, or -1 for an invalid code. */
export function holdemCardIndex(c: unknown): number {
  if (typeof c !== 'string' || c.length !== 2) return -1;
  const r = HOLDEM_RANKS.indexOf(c[0]!);
  const s = HOLDEM_SUITS.indexOf(c[1]!);
  return r < 0 || s < 0 ? -1 : r * 4 + s;
}

export function isHoldemCard(c: unknown): c is Card {
  return holdemCardIndex(c) >= 0;
}

/** Rank value 0 (deuce) .. 12 (ace). */
export function holdemRank(c: Card): number {
  return HOLDEM_RANKS.indexOf(c[0]!);
}

export function holdemCardFromIndex(i: number): Card {
  return HOLDEM_RANKS[i >> 2]! + HOLDEM_SUITS[i & 3]!;
}
