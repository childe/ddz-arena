// Two-deck helpers: same card codes as the 3-player game, each code present twice. Hands and plays are
// multisets, so containment and removal count copies instead of using sets.
import { type Card, fullDeck } from '../cards.ts';

export const DECK4_SIZE = 108;

export function fullDeck4(): Card[] {
  return [...fullDeck(), ...fullDeck()];
}

function tally(cards: Card[]): Map<Card, number> {
  const m = new Map<Card, number>();
  for (const c of cards) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}

/** Returns true if `cards` is a sub-multiset of `hand` (each copy in `cards` needs its own copy in `hand`). */
export function containsAll4(hand: Card[], cards: Card[]): boolean {
  const avail = tally(hand);
  for (const c of cards) {
    const n = avail.get(c) ?? 0;
    if (n === 0) return false;
    avail.set(c, n - 1);
  }
  return true;
}

/** Removes one copy of `hand` per entry in `cards` (cards not in hand are ignored). */
export function removeCards4(hand: Card[], cards: Card[]): Card[] {
  const rm = tally(cards);
  return hand.filter((c) => {
    const n = rm.get(c) ?? 0;
    if (n === 0) return true;
    rm.set(c, n - 1);
    return false;
  });
}
