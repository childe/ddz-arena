import { type Card, sortCards, SUITS } from '../cards.ts';
import {
  type GdLevel, gdRank, gdRankLabel, levelRank, wildcardOf, isWildcard, sortByValue, GD_RANK_A, GD_RANK_BJ, GD_RANK_RJ, GD_RANK_SLOTS,
} from './cards.ts';
import { type GdPattern, type GdPatternType, beatsGd } from './patterns.ts';

export interface GdMove {
  cards: Card[];
  pattern: GdPattern;
}

/** Natural rank at sequence position p (1 is A low, 14 A high). */
const atSeq = (p: number) => (p === 1 ? GD_RANK_A : p);

/**
 * Calls `cb` with every way to spread at most `wild` wildcards over positions that each need `need`
 * cards, where position i has `avail[i]` natural cards; `w[i]` is how many wildcards go to position i.
 */
function eachWildSpread(avail: number[], need: number, wild: number, cb: (w: number[]) => void): void {
  const w = new Array<number>(avail.length).fill(0);
  const rec = (i: number, left: number) => {
    if (i === avail.length) { cb(w); return; }
    for (let k = 0; k <= Math.min(need, left); k++) {
      if (avail[i]! < need - k) continue;
      w[i] = k;
      rec(i + 1, left - k);
    }
    w[i] = 0;
  };
  rec(0, wild);
}

/**
 * Enumerates every distinct legal play from `hand` at `level`: one move per pattern and rank multiset
 * (wildcards counted separately), natural cards picked lowest suit first, straight flushes in their own
 * suit. Plays using 0, 1 or 2 wildcards are all listed. With `toBeat`, only plays that beat it; passing
 * is not included.
 */
export function legalMovesGd(hand: Card[], toBeat: GdPattern | null, level: GdLevel): GdMove[] {
  const lv = levelRank(level);
  const wildCard = wildcardOf(level);
  // Natural (non-wildcard) cards of each rank in suit order.
  const byRank: Card[][] = Array.from({ length: GD_RANK_SLOTS }, () => []);
  let wild = 0;
  for (const c of sortCards(hand)) {
    if (c === wildCard) wild++;
    else byRank[gdRank(c)]!.push(c);
  }
  const avail = byRank.map((cs) => cs.length);
  const found = new Map<string, GdMove>();

  const add = (type: GdPatternType, rank: number, length: number, picked: Card[], wilds: number) => {
    const pattern: GdPattern = { type, rank: gdRankLabel(rank), length };
    if (toBeat && !beatsGd(pattern, toBeat, level)) return;
    const cards = sortCards(wilds ? [...picked, ...new Array<Card>(wilds).fill(wildCard)] : picked);
    const key = `${type}:${pattern.rank}:${cards.join(',')}`;
    if (!found.has(key)) found.set(key, { cards, pattern });
  };

  // When following a non-bomb only its type (plus bombs) can apply; bombs are only beaten by bombs.
  const bombOnly = toBeat !== null && (toBeat.type === 'bomb' || toBeat.type === 'straight_flush' || toBeat.type === 'rocket');
  const want = (t: GdPatternType) =>
    !toBeat || t === 'bomb' || t === 'straight_flush' || t === 'rocket' || (!bombOnly && toBeat.type === t);

  // Same-rank plays: `size` cards of rank r, `w` of them wildcards. All-wildcard plays are level cards.
  const sameRank = (type: GdPatternType, r: number, size: number) => {
    for (let w = 0; w <= Math.min(wild, size); w++) {
      if (avail[r]! < size - w) continue;
      if (w === size && r !== lv) continue;
      if (w > 0 && r >= GD_RANK_BJ) continue;
      add(type, r, type === 'bomb' ? size : 1, byRank[r]!.slice(0, size - w), w);
    }
  };
  for (let r = 2; r <= GD_RANK_RJ; r++) {
    if (want('single')) sameRank('single', r, 1);
    if (want('pair')) sameRank('pair', r, 2);
    if (r > GD_RANK_A) continue;
    if (want('triple')) sameRank('triple', r, 3);
    if (want('bomb')) for (let size = 4; size <= 8; size++) sameRank('bomb', r, size);
  }
  if (want('rocket') && avail[GD_RANK_BJ] === 2 && avail[GD_RANK_RJ] === 2) {
    add('rocket', GD_RANK_RJ, 4, [...byRank[GD_RANK_BJ]!, ...byRank[GD_RANK_RJ]!], 0);
  }

  if (want('triple_pair')) {
    for (let t = 2; t <= GD_RANK_A; t++) {
      for (let wt = 0; wt <= Math.min(wild, 2); wt++) {
        if (avail[t]! < 3 - wt) continue;
        const triple = byRank[t]!.slice(0, 3 - wt);
        let allWildPairDone = false;
        for (let p = 2; p <= GD_RANK_RJ; p++) {
          if (p === t) continue;
          for (let wp = 0; wp <= Math.min(wild - wt, 2); wp++) {
            if (avail[p]! < 2 - wp || (wp > 0 && p >= GD_RANK_BJ)) continue;
            // A pair made only of wildcards is the same play whatever rank it stands for.
            if (wp === 2) {
              if (allWildPairDone) continue;
              allWildPairDone = true;
            }
            add('triple_pair', t, 1, [...triple, ...byRank[p]!.slice(0, 2 - wp)], wt + wp);
          }
        }
      }
    }
  }

  // Sequences: `len` positions ending at sequence value `top`, `need` cards each, drawn from `pool`.
  const sequences = (type: GdPatternType, len: number, need: number, pool: Card[][]) => {
    for (let top = len; top <= GD_RANK_A; top++) {
      const pos: number[] = [];
      for (let p = top - len + 1; p <= top; p++) pos.push(atSeq(p));
      eachWildSpread(pos.map((r) => pool[r]!.length), need, wild, (w) => {
        const picked: Card[] = [];
        let used = 0;
        pos.forEach((r, i) => {
          picked.push(...pool[r]!.slice(0, need - w[i]!));
          used += w[i]!;
        });
        add(type, top, 1, picked, used);
      });
    }
  };
  if (want('straight')) sequences('straight', 5, 1, byRank);
  if (want('pair_chain')) sequences('pair_chain', 3, 2, byRank);
  if (want('plane')) sequences('plane', 2, 3, byRank);
  if (want('straight_flush')) {
    for (const s of SUITS) sequences('straight_flush', 5, 1, byRank.map((cs) => cs.filter((c) => c[1] === s)));
  }
  return [...found.values()];
}

/** Lowest-value single to lead with, avoiding the wildcard unless nothing else is left. */
export function lowestSingleGd(hand: Card[], level: GdLevel): Card[] {
  const natural = hand.filter((c) => !isWildcard(c, level));
  if (natural.length) return [sortByValue(natural, level)[0]!];
  return hand.length ? [hand[0]!] : [];
}
