import { describe, it, expect } from 'vitest';
import {
  GongzhuGame, newGzMatch, nextGzMatch, scoreTaken, settleGz, sortGz, fullDeckGz, heartPoints,
  GZ_MATCH_LOSS, type GzHands, type GzSeat, type GongzhuMatch,
} from '../src/gongzhu/index.ts';
import { GameError } from '../src/game.ts';

const c = (s: string) => s.split(' ').filter(Boolean);
const HEARTS = c('2H 3H 4H 5H 6H 7H 8H 9H TH JH QH KH AH');

function expectError(fn: () => unknown, code: string, status = 422) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    expect((e as GameError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
}

// Seat 0: all spades. Seat 1: all hearts. Seat 2: all clubs. Seat 3: all diamonds.
const bySuit = (): GzHands => ['S', 'H', 'C', 'D'].map((s) => fullDeckGz().filter((x) => x[1] === s)) as GzHands;

describe('cards', () => {
  it('hearts sum to -200', () => {
    expect(HEARTS.reduce((n, x) => n + heartPoints(x), 0)).toBe(-200);
    expect(c('AH KH QH JH TH 5H 4H').map(heartPoints)).toEqual([-50, -40, -30, -20, -10, -10, 0]);
  });
  it('sorts by suit then rank', () => {
    expect(sortGz(c('AD 2S TH 3S KC'))).toEqual(c('2S 3S TH KC AD'));
  });
});

describe('scoreTaken', () => {
  const cases: [string, string, number][] = [
    ['', '', 0],
    ['QS', '', -100],
    ['QS', 'QS', -200],
    ['JD', '', 100],
    ['JD', 'JD', 200],
    ['TC', '', 50],
    ['TC', 'TC', 100],
    ['TC 2H', '', 0], // a zero heart is still a scoring card: 0 x 2
    ['TC QS', '', -200],
    ['TC QS', 'TC', -400],
    ['TC JD AH', '', 100],
    ['AH KH', '', -90],
    ['AH KH', 'AH', -180],
    ['QS JD', '', 0],
  ];
  for (const [taken, ex, want] of cases) it(`${taken || '-'} / exposed ${ex || '-'} = ${want}`, () => expect(scoreTaken(c(taken), c(ex))).toBe(want));

  it('all hearts is +200 and turns the pig positive', () => {
    expect(scoreTaken(HEARTS, [])).toBe(200);
    expect(scoreTaken(HEARTS, ['AH'])).toBe(400);
    expect(scoreTaken([...HEARTS, 'QS'], [])).toBe(300);
    expect(scoreTaken([...HEARTS, 'QS', 'JD', 'TC'], [])).toBe(800);
    expect(scoreTaken([...HEARTS, 'QS', 'JD', 'TC'], ['AH', 'QS', 'JD', 'TC'])).toBe(3200);
  });
});

describe('settleGz', () => {
  it('scores are zero-sum and the match ends at -1000', () => {
    const m: GongzhuMatch = { handNo: 5, totals: [-950, 0, 100, 0], leader: 1 };
    const r = settleGz(m, [c('QS'), HEARTS.slice(0, 12), c('JD TC'), c('AH')], [[], [], [], []]);
    expect(r.points).toEqual([-100, -150, 200, -50]);
    expect(r.totals_after).toEqual([-1050, -150, 300, -50]);
    expect(r.scores.reduce((a, b) => a + b, 0)).toBe(0);
    expect(r.scores).toEqual([-30, -50, 90, -10]);
    expect(r.losers).toEqual([0]);
    expect(r.match_over).toBe(true);
    expect(r.pig).toBe(0);
    expect(r.all_hearts).toBeNull();
    expect(nextGzMatch(m, r)).toEqual(newGzMatch());
  });

  it('carries totals and the pig taker leads next', () => {
    const m = newGzMatch();
    const r = settleGz(m, [[], c('QS'), HEARTS, c('JD TC')], [[], ['QS'], [], []]);
    expect(r.points).toEqual([0, -200, 200, 200]);
    expect(r.all_hearts).toBe(2);
    expect(nextGzMatch(m, r)).toEqual({ handNo: 2, totals: [0, -200, 200, 200], leader: 1 });
    expect(GZ_MATCH_LOSS).toBe(-1000);
  });
});

describe('GongzhuGame', () => {
  it('2C holder exposes and leads first; seats expose in turn', () => {
    const g = new GongzhuGame('s', newGzMatch(), bySuit());
    expect(g.firstLeader).toBe(2);
    expect(g.phase).toBe('expose');
    expect(g.turn).toBe(2);
    expect(g.exposable(2)).toEqual(['TC']);
    expect(g.exposable(1)).toEqual(['AH']);
    expectError(() => g.expose(0, []), 'NOT_YOUR_TURN', 409);
    expectError(() => g.expose(2, ['QS']), 'BAD_EXPOSE');
    expectError(() => g.expose(2, ['TC', 'TC']), 'BAD_EXPOSE');
    expectError(() => g.play(2, '2C'), 'WRONG_PHASE', 409);
    expect(g.expose(2, ['TC'])).toEqual(['TC']);
    expect(g.turn).toBe(3);
    g.expose(3, []);
    g.expose(0, ['QS']);
    g.expose(1, []);
    expect(g.phase).toBe('playing');
    expect(g.turn).toBe(2);
    expect(g.exposed).toEqual([['QS'], [], ['TC'], []]);
  });

  it('three exposed: the fourth is exposed for its holder when the last seat has decided', () => {
    // bySuit: seat 0 holds QS, 1 AH, 2 TC, 3 JD; seat 2 decides first.
    let g = new GongzhuGame('s', newGzMatch(), bySuit());
    g.expose(2, ['TC']);
    g.expose(3, []);
    g.expose(0, ['QS']);
    expect(g.forcedExpose).toBeNull();
    g.expose(1, ['AH']);
    // Seat 3 had already said no.
    expect(g.forcedExpose).toEqual({ seat: 3, card: 'JD' });
    expect(g.exposed).toEqual([['QS'], ['AH'], ['TC'], ['JD']]);
    expect(g.phase).toBe('playing');

    // The holder decides last and does not expose it.
    g = new GongzhuGame('s', newGzMatch(), bySuit());
    g.expose(2, ['TC']);
    g.expose(3, ['JD']);
    g.expose(0, ['QS']);
    g.expose(1, []);
    expect(g.forcedExpose).toEqual({ seat: 1, card: 'AH' });
    expect(g.exposed[1]).toEqual(['AH']);

    // One seat holds all four and exposes three: the fourth joins them, in the usual order.
    const deal = bySuit();
    const swap = (a: GzSeat, ca: string, b: GzSeat, cb: string) => {
      deal[a] = deal[a].map((x) => (x === ca ? cb : x));
      deal[b] = deal[b].map((x) => (x === cb ? ca : x));
    };
    swap(0, '2S', 3, 'JD');
    swap(0, '3S', 2, 'TC');
    swap(0, '4S', 1, 'AH');
    g = new GongzhuGame('s', newGzMatch(), deal);
    expect(g.exposable(0)).toEqual(['QS', 'JD', 'TC', 'AH']);
    for (const s of [2, 3] as GzSeat[]) g.expose(s, []);
    g.expose(0, ['AH', 'QS', 'TC']);
    g.expose(1, []);
    expect(g.forcedExpose).toEqual({ seat: 0, card: 'JD' });
    expect(g.exposed[0]).toEqual(['QS', 'JD', 'TC', 'AH']);
  });

  it('two or four exposed: nothing is forced', () => {
    let g = new GongzhuGame('s', newGzMatch(), bySuit());
    for (const [s, cards] of [[2, ['TC']], [3, []], [0, ['QS']], [1, []]] as [GzSeat, string[]][]) g.expose(s, cards);
    expect(g.forcedExpose).toBeNull();
    expect(g.exposed).toEqual([['QS'], [], ['TC'], []]);
    g = new GongzhuGame('s', newGzMatch(), bySuit());
    for (const [s, cards] of [[2, ['TC']], [3, ['JD']], [0, ['QS']], [1, ['AH']]] as [GzSeat, string[]][]) g.expose(s, cards);
    expect(g.forcedExpose).toBeNull();
  });

  it('the previous pig taker leads', () => {
    const g = new GongzhuGame('s', { handNo: 2, totals: [0, 0, 0, 0], leader: 3 }, bySuit());
    expect(g.firstLeader).toBe(3);
    expect(g.turn).toBe(3);
  });

  it('must follow suit; highest of the led suit wins and leads', () => {
    const deal: GzHands = [
      c('2S 3S 4S 5S 6S 7S 8S 9S TS JS QS KS 2H'),
      c('AS 3H 4H 5H 6H 7H 8H 9H TH JH QH KH AH'),
      c('2C 3C 4C 5C 6C 7C 8C 9C TC JC QC KC AC'),
      c('2D 3D 4D 5D 6D 7D 8D 9D TD JD QD KD AD'),
    ];
    const g = new GongzhuGame('s', { handNo: 2, totals: [0, 0, 0, 0], leader: 0 }, deal);
    for (const s of [0, 1, 2, 3] as GzSeat[]) g.expose(s, []);
    g.play(0, '2H');
    expectError(() => g.play(1, 'AS'), 'MUST_FOLLOW_SUIT');
    expect(g.legalCards()).toEqual(c('3H 4H 5H 6H 7H 8H 9H TH JH QH KH AH'));
    g.play(1, 'AH');
    expect(g.legalCards()).toHaveLength(13); // void in hearts
    g.play(2, 'TC');
    const t = g.play(3, 'JD')!;
    expect(t.winner).toBe(1);
    expect(g.turn).toBe(1);
    expect(sortGz(g.taken[1])).toEqual(c('2H AH TC JD'));
    expect(g.trickNo).toBe(2);
  });

  it('an exposed card is locked in the first round of its suit unless it is the only one', () => {
    const deal: GzHands = [
      c('QS 2S 3H 4H 5H 6H 7H 8H 9H TH JH QH KH'),
      c('AS 3S AH 2C 3C 4C 5C 6C 7C 8C 9C 2D 3D'),
      c('KS 4S TC JC QC KC AC 4D 5D 6D 7D 8D 9D'),
      c('5S 6S 7S 8S 9S TS JS 2H TD JD QD KD AD'),
    ];
    const g = new GongzhuGame('s', { handNo: 2, totals: [0, 0, 0, 0], leader: 0 }, deal);
    g.expose(0, ['QS']);
    g.expose(1, ['AH']);
    g.expose(2, []);
    g.expose(3, []);
    expect(g.legalCards()).not.toContain('QS');
    expectError(() => g.play(0, 'QS'), 'EXPOSED_CARD_LOCKED');
    g.play(0, '3H');
    // Seat 1 has only AH in hearts: allowed although exposed.
    expect(g.legalCards()).toEqual(['AH']);
    g.play(1, 'AH');
    g.play(2, '4D');
    g.play(3, '2H');
    expect(g.turn).toBe(1);
    g.play(1, 'AS');
    g.play(2, '4S');
    g.play(3, '5S');
    // First spade round: seat 0 must follow but QS is locked while 2S remains.
    expect(g.legalCards()).toEqual(['2S']);
    g.play(0, '2S');
    expect(g.turn).toBe(1);
    g.play(1, '3S');
    g.play(2, 'KS');
    g.play(3, '6S');
    // Spades were led before: QS is free now.
    expect(g.legalCards()).toEqual(['QS']);
  });

  it('an exposed card may be discarded before its suit is led', () => {
    const deal: GzHands = [
      c('QS 2S 3S 2C 3C 4C 5C 6C 7C 8C 9C TC JC'),
      c('2H 3H 4H 5H 6H 7H 8H 9H TH JH QH KH AH'),
      c('4S 5S 6S 7S 8S 9S TS JS KS AS QC KC AC'),
      c('2D 3D 4D 5D 6D 7D 8D 9D TD JD QD KD AD'),
    ];
    const g = new GongzhuGame('s', { handNo: 2, totals: [0, 0, 0, 0], leader: 1 }, deal);
    g.expose(1, []);
    g.expose(2, []);
    g.expose(3, []);
    g.expose(0, ['QS']);
    g.play(1, '2H');
    g.play(2, '4S');
    g.play(3, '2D');
    expect(g.legalCards()).toContain('QS');
    g.play(0, 'QS');
    expect(g.taken[1]).toEqual(['2H', 'QS']);
  });

  it('ends early once every scoring card is taken', () => {
    const g = new GongzhuGame('s', { handNo: 2, totals: [0, 0, 0, 0], leader: 1 }, bySuit());
    for (const s of [1, 2, 3, 0] as GzSeat[]) g.expose(s, []);
    // Seat 1 leads hearts each trick; nobody else has hearts, so seat 1 takes them all.
    // The pig (seat 0), goat (seat 3) and transformer (seat 2) are discarded on the first tricks.
    const discards: Record<number, string[]> = { 0: c('QS'), 2: c('TC'), 3: c('JD') };
    for (let i = 0; i < 13 && g.phase === 'playing'; i++) {
      g.play(1, g.legalCards().at(-1)!);
      for (const s of [2, 3, 0] as GzSeat[]) g.play(s, discards[s]!.shift() ?? g.legalCards()[0]!);
    }
    expect(g.phase).toBe('finished');
    expect(g.tricks).toHaveLength(13);
    expect(g.result!.points).toEqual([0, 800, 0, 0]);
    expect(g.result!.all_hearts).toBe(1);
  });

  it('random games played by autoAction finish consistently', () => {
    let m = newGzMatch();
    for (let i = 0; i < 60; i++) {
      const g = new GongzhuGame(`seed-${i}`, m);
      expect(g.hands.flat().sort()).toEqual(fullDeckGz().sort());
      while (g.phase !== 'finished') {
        const a = g.autoAction();
        if (a.kind === 'expose') g.expose(g.turn, i % 3 === 0 ? g.exposable(g.turn) : []);
        else {
          expect(g.legalCards()).toContain(a.card);
          g.play(g.turn, a.card);
        }
      }
      const r = g.result!;
      expect(r.taken.flat()).toHaveLength(16);
      expect(r.scores.reduce((a, b) => a + b, 0)).toBe(0);
      r.points.forEach((p, s) => expect(p).toBe(scoreTaken(r.taken[s], r.exposed.flat())));
      expect(r.pig).not.toBeNull();
      m = nextGzMatch(m, r);
    }
  });
});
