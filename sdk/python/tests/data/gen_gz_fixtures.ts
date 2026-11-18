// Generates gz_fixtures.json: reference outputs of the TypeScript Gongzhu engine (the source of truth)
// for the Python port in ddz_sdk.rules_gz. Re-run after engine rule changes:
//
//   cd <repo root> && node --disable-warning=ExperimentalWarning \
//     sdk/python/tests/data/gen_gz_fixtures.ts > sdk/python/tests/data/gz_fixtures.json
import {
  EXPOSABLE, GongzhuGame, fullDeckGz, isScoring, newGzMatch, scoreTaken, settleGz,
  type GongzhuMatch, type GzSeat,
} from '../../../../packages/engine/src/gongzhu/index.ts';
import { createRng, shuffle } from '../../../../packages/engine/src/rng.ts';

const rng = createRng('sdk-python-gz-fixtures');
const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)]!;
const SCORING = fullDeckGz().filter(isScoring);
const HEARTS = SCORING.filter((c) => c[1] === 'H');

// --- scoreTaken on random subsets of the 16 scoring cards with random exposures; every 5th case
// takes all 13 hearts so 全红 and 全收 show up often.
const score: unknown[] = [];
for (let i = 0; i < 600; i++) {
  const base = i % 5 === 0 ? [...HEARTS] : [];
  const rest = SCORING.filter((c) => !base.includes(c));
  const extra = shuffle(rest, rng).slice(0, Math.floor(rng() * (rest.length + 1)));
  const taken = shuffle([...base, ...extra], rng);
  const exposed = EXPOSABLE.filter(() => rng() < 0.35);
  score.push({ taken, exposed, points: scoreTaken(taken, exposed) });
}

// --- whole hands with random exposures and random legal plays: the legal cards before every play,
// every trick winner and the final result. Some hands continue a match (leader and totals given).
const games: unknown[] = [];
for (let i = 0; i < 150; i++) {
  const match: GongzhuMatch =
    i % 3 === 0
      ? { handNo: 2, totals: [-950, -300, 100, 0].map((t) => t + 10 * Math.floor(rng() * 20)) as GongzhuMatch['totals'], leader: pick([0, 1, 2, 3]) as GzSeat }
      : newGzMatch();
  const g = new GongzhuGame(`gz-fixture-${i}`, match);
  const exposeOrder: number[] = [];
  while (g.phase === 'expose') {
    const s = g.turn;
    exposeOrder.push(s);
    g.expose(s, g.exposable(s).filter(() => rng() < 0.5));
  }
  const plays: { seat: number; card: string; legal: string[]; rejected: string[]; winner: number | null }[] = [];
  // A fresh copy of this hand replayed up to now, to ask the engine whether `card` would be accepted.
  const rejectedBy = (card: string): string | null => {
    const h = new GongzhuGame(g.seed, match, g.initialHands);
    for (const s of exposeOrder) h.expose(s as GzSeat, g.exposed[s]!);
    for (const p of plays) h.play(p.seat as GzSeat, p.card);
    try {
      h.play(h.turn, card);
      return null;
    } catch (e) {
      return (e as { code: string }).code;
    }
  };
  while (g.phase === 'playing') {
    const seat = g.turn;
    const legal = g.legalCards();
    // Cards legalCards() offers but play() refuses (an exposed card discarded before its suit was led).
    const rejected = legal.filter((c) => rejectedBy(c) !== null);
    const ok = legal.filter((c) => !rejected.includes(c));
    // Bias towards scoring cards sometimes so hands end early now and then.
    const scoring = ok.filter(isScoring);
    const card = scoring.length && rng() < 0.3 ? pick(scoring) : pick(ok);
    const t = g.play(seat, card);
    plays.push({ seat, card, legal, rejected, winner: t ? t.winner : null });
  }
  games.push({
    match: { hand_no: match.handNo, totals: match.totals, leader: match.leader },
    hands: g.initialHands,
    first_leader: g.firstLeader,
    expose_order: exposeOrder,
    exposed: g.exposed,
    forced: g.forcedExpose,
    plays,
    result: g.result,
  });
}

// --- settleGz directly, to pin the losers / match_over / scores fields.
const settle: unknown[] = [];
for (let i = 0; i < 100; i++) {
  const deck = shuffle(SCORING, rng);
  const taken = [[], [], [], []] as [string[], string[], string[], string[]];
  for (const c of deck) taken[Math.floor(rng() * 4)]!.push(c);
  if (i % 7 === 0) {
    taken[0] = [...HEARTS, 'QS'];
    taken[1] = ['JD'];
    taken[2] = ['TC'];
    taken[3] = [];
  }
  const exposed = [[], [], [], []] as [string[], string[], string[], string[]];
  for (const c of EXPOSABLE) if (rng() < 0.3) exposed[Math.floor(rng() * 4)]!.push(c);
  const totals = [0, 1, 2, 3].map(() => -10 * Math.floor(rng() * 110)) as GongzhuMatch['totals'];
  const match: GongzhuMatch = { handNo: 3, totals, leader: null };
  settle.push({ totals, taken, exposed, result: settleGz(match, taken, exposed) });
}

process.stdout.write(JSON.stringify({ score_taken: score, games, settle }) + '\n');
