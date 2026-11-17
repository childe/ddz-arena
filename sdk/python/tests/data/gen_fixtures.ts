// Generates engine_fixtures.json: reference outputs of the TypeScript engine (the source of truth)
// for the Python ports in ddz_sdk.rules4 and ddz_sdk.holdem. Re-run after engine rule changes:
//
//   cd <repo root> && node --disable-warning=ExperimentalWarning \
//     sdk/python/tests/data/gen_fixtures.ts > sdk/python/tests/data/engine_fixtures.json
import { identify4, legalMoves4, resolve4, fullDeck4, type Pattern4 } from '../../../../packages/engine/src/ddz4/index.ts';
import { evaluateHoldem, holdemDeck } from '../../../../packages/engine/src/holdem/index.ts';
import { sortCards, rankOf } from '../../../../packages/engine/src/cards.ts';
import { createRng, shuffle } from '../../../../packages/engine/src/rng.ts';

const rng = createRng('sdk-python-fixtures');
const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
const pat = (p: Pattern4 | null) => (p ? [p.type, p.main, p.length] : null);
const moveKey = (m: { cards: string[]; pattern: Pattern4 }) =>
  `${m.pattern.type}:${m.pattern.main}:${m.pattern.length}:${m.cards.join(',')}`;

// --- ddz4 identify / resolve on random small plays drawn from a few ranks (lots of duplicates).
const identify: unknown[] = [];
for (let i = 0; i < 1500; i++) {
  const lo = Math.floor(rng() * 10);
  const pool = fullDeck4().filter((c) => (rankOf(c) >= lo && rankOf(c) < lo + 4) || (i % 4 === 0 && rankOf(c) >= 13));
  const n = 1 + Math.floor(rng() * 12);
  const cards = sortCards(shuffle(pool, rng).slice(0, n));
  identify.push({ cards, patterns: identify4(cards).map(pat) });
}

// --- ddz4 legal moves: random hands of various sizes against assorted plays to beat.
const lastPlays: (string[] | null)[] = [
  null, ['5S'], ['RJ'], ['6S', '6H'], ['BJ', 'BJ'], ['3S', '3H', '3C', '4S'], ['3S', '3H', '3C', '4S', '4H'],
  ['3S', '4S', '5S', '6S', '7S'], ['3S', '3H', '4S', '4H', '5S', '5H'], ['3S', '3H', '3C', '4S', '4H', '4C'],
  ['3S', '3H', '3C', '4S', '4H', '4C', '5S', '6S'], ['3S', '3H', '3C', '4S', '4H', '4C', '5S', '5H', '6S', '6H'],
  ['3S', '3H', '3C', '3D'], ['7S', '7H', '7C', '7D', '7S'], ['8S', '8H', '8C'], ['KS', 'KH', 'KC', 'KD', 'KS', 'KH'],
];
const legal: unknown[] = [];
for (let i = 0; i < 160; i++) {
  const size = i < 120 ? 6 + Math.floor(rng() * 14) : 25 + Math.floor(rng() * 9);
  const pool = i % 3 === 0 ? fullDeck4().filter((c) => rankOf(c) < 8 || rankOf(c) >= 13) : fullDeck4();
  const hand = sortCards(shuffle(pool, rng).slice(0, size));
  const lastCards = i < 120 ? pick(lastPlays) : pick(lastPlays.slice(1));
  const last = lastCards ? resolve4(lastCards, null) : null;
  if (last && !last.ok) throw new Error('bad last play');
  const lastPattern = last && last.ok ? last.pattern : null;
  legal.push({ hand, last: pat(lastPattern), moves: legalMoves4(hand, lastPattern).map(moveKey).sort() });
}

// --- resolve4 of random legal-looking plays against random patterns.
const resolve: unknown[] = [];
for (let i = 0; i < 400; i++) {
  const hand = sortCards(shuffle(fullDeck4(), rng).slice(0, 16));
  const moves = legalMoves4(hand, null);
  const m = pick(moves);
  const lastCards = pick(lastPlays);
  const lastR = lastCards ? resolve4(lastCards, null) : null;
  const last = lastR && lastR.ok ? lastR.pattern : null;
  const r = resolve4(m.cards, last);
  resolve.push({ cards: m.cards, last: pat(last), result: r.ok ? pat(r.pattern) : r.code });
}

// --- holdem evaluator on random 5..7 card sets.
const holdem: unknown[] = [];
for (let i = 0; i < 3000; i++) {
  const n = 5 + (i % 3);
  // Every other set comes from a narrow pool (few ranks / suits) to hit quads, full houses, straight flushes.
  const lo = Math.floor(rng() * 8);
  const pool = i % 2 === 0 ? holdemDeck() : holdemDeck().filter((c, k) => (k >> 2 >= lo && k >> 2 < lo + 6) || c === 'AS' || c === 'AH');
  const cards = shuffle(pool, rng).slice(0, n);
  const v = evaluateHoldem(cards);
  holdem.push({ cards, score: v.score, rank: v.rank, best: v.best });
}

process.stdout.write(JSON.stringify({ identify4: identify, legal_moves4: legal, resolve4: resolve, holdem }) + '\n');
