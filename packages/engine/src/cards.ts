// Card codes: rank char + suit char, e.g. "3S", "TH", "2D"; jokers are "BJ" (small) and "RJ" (big).
export type Card = string;

export const RANK_CHARS = '3456789TJQKA2';
export const SUITS = 'SHCD';
export const SMALL_JOKER = 'BJ';
export const BIG_JOKER = 'RJ';

// Rank values: 3..A => 0..11, 2 => 12, BJ => 13, RJ => 14.
export const RANK_A = 11;
export const RANK_2 = 12;
export const RANK_BJ = 13;
export const RANK_RJ = 14;
export const RANK_COUNT = 15;

export const RANK_LABELS = [...RANK_CHARS.split(''), 'BJ', 'RJ'];

const ALL_CARDS: Card[] = [];
for (const r of RANK_CHARS) for (const s of SUITS) ALL_CARDS.push(r + s);
ALL_CARDS.push(SMALL_JOKER, BIG_JOKER);
const CARD_SET = new Set(ALL_CARDS);

export function fullDeck(): Card[] {
  return [...ALL_CARDS];
}

export function isValidCard(c: unknown): c is Card {
  return typeof c === 'string' && CARD_SET.has(c);
}

export function rankOf(c: Card): number {
  if (c === SMALL_JOKER) return RANK_BJ;
  if (c === BIG_JOKER) return RANK_RJ;
  const r = RANK_CHARS.indexOf(c[0]!);
  if (r < 0 || c.length !== 2) throw new Error(`invalid card ${c}`);
  return r;
}

function cardOrder(c: Card): number {
  const r = rankOf(c);
  return r * 4 + (r >= RANK_BJ ? 0 : SUITS.indexOf(c[1]!));
}

export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => cardOrder(a) - cardOrder(b));
}

/** counts[rank] = number of cards of that rank */
export function rankCounts(cards: Card[]): number[] {
  const counts = new Array<number>(RANK_COUNT).fill(0);
  for (const c of cards) counts[rankOf(c)]!++;
  return counts;
}

/** Returns true if every card in `cards` is distinct and present in `hand`. */
export function containsAll(hand: Card[], cards: Card[]): boolean {
  const set = new Set(hand);
  const seen = new Set<Card>();
  for (const c of cards) {
    if (!set.has(c) || seen.has(c)) return false;
    seen.add(c);
  }
  return true;
}

export function removeCards(hand: Card[], cards: Card[]): Card[] {
  const rm = new Set(cards);
  return hand.filter((c) => !rm.has(c));
}

/** Picks concrete cards from `hand` matching a rank multiset (lowest suits first). */
export function pickByRanks(hand: Card[], ranks: number[]): Card[] {
  const pool = new Map<number, Card[]>();
  for (const c of sortCards(hand)) {
    const r = rankOf(c);
    if (!pool.has(r)) pool.set(r, []);
    pool.get(r)!.push(c);
  }
  const out: Card[] = [];
  for (const r of ranks) {
    const c = pool.get(r)?.shift();
    if (!c) throw new Error(`rank ${RANK_LABELS[r]} not available`);
    out.push(c);
  }
  return sortCards(out);
}
