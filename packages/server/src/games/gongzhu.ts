// Gongzhu (拱猪) adapter (docs/gongzhu.md). Each session is one hand; the match state (totals, who
// leads) is carried from the previous session in the room.
import { GongzhuGame, isScoring, newGzMatch, nextGzMatch, type Card, type GongzhuMatch, type GzSeat, type GzTrick } from '@ddz/engine';
import { badRequest } from '../errors.ts';
import { timeoutMs } from './ddz.ts';
import type { ActResult, Emit, GameSession, GameVariant, PlayerOutcome } from './types.ts';

const SEATS = [0, 1, 2, 3];
const serializeTrick = (t: GzTrick) => ({ leader: t.leader, plays: t.plays, winner: t.winner });

class GongzhuSession implements GameSession {
  readonly seats = SEATS;
  readonly g: GongzhuGame;

  constructor(seed: string, match: GongzhuMatch) {
    this.g = new GongzhuGame(seed, match);
  }

  get seed() {
    return this.g.seed;
  }
  get finished() {
    return this.g.phase === 'finished';
  }
  get turn() {
    return this.finished ? null : this.g.turn;
  }
  get redeal() {
    return false;
  }

  startEvents(): Emit[] {
    const g = this.g;
    const priv: Record<number, Record<string, unknown>> = {};
    for (const s of SEATS) priv[s] = { hand: g.initialHands[s] };
    return [{ type: 'game.started', data: { hand_no: g.handNo, totals: g.match.totals, first_leader: g.firstLeader, cards_left: g.cardsLeft }, priv }];
  }

  private trickView() {
    return this.g.trick ? serializeTrick(this.g.trick) : null;
  }

  turnEvent(): Emit {
    const g = this.g;
    return { type: 'turn', data: { seat: g.turn, phase: g.phase, trick_no: g.trickNo, led_suit: g.ledSuit, trick: this.trickView() } };
  }

  turnTimeout(config: Record<string, unknown>) {
    return config.play_timeout_ms as number;
  }

  act(seat: number, op: string, body: Record<string, unknown>): ActResult {
    if (op === 'expose') {
      const { cards } = body;
      if (!Array.isArray(cards) || cards.some((c) => typeof c !== 'string')) throw badRequest('cards must be an array of card codes');
      return { events: this.expose(seat, cards as Card[], false) };
    }
    if (op === 'play') {
      let card = body.card;
      if (card === undefined && Array.isArray(body.cards)) {
        if (body.cards.length !== 1) throw badRequest('play exactly one card');
        card = body.cards[0];
      }
      if (typeof card !== 'string') throw badRequest('card must be a card code');
      return { events: this.play(seat, card, false) };
    }
    throw badRequest(`this game uses expose and play, not ${op}`);
  }

  private expose(seat: number, cards: Card[], auto: boolean): Emit[] {
    const g = this.g;
    const shown = [...g.expose(seat as GzSeat, cards)];
    const events: Emit[] = [{ type: 'exposed', data: { seat, cards: shown, auto } }];
    // Three exposed: the fourth is exposed for its holder, with all that seat's exposed cards like any `exposed`.
    const f = g.forcedExpose;
    if (f) events.push({ type: 'exposed', data: { seat: f.seat, cards: [...g.exposed[f.seat]], auto: true, forced: f.card } });
    return events;
  }

  private play(seat: number, card: Card, auto: boolean): Emit[] {
    const g = this.g;
    const trickNo = g.trickNo;
    const done = g.play(seat as GzSeat, card);
    const events: Emit[] = [{ type: 'played', data: { seat, card, trick_no: trickNo, cards_left: g.cardsLeft, auto } }];
    if (done) {
      events.push({
        type: 'trick.won',
        data: { seat: done.winner, trick_no: trickNo, plays: done.plays, cards: done.plays.map((p) => p.card).filter(isScoring) },
      });
    }
    return events;
  }

  auto(seat: number): Emit[] {
    const a = this.g.autoAction();
    return a.kind === 'expose' ? this.expose(seat, a.cards, true) : this.play(seat, a.card, true);
  }

  publicView() {
    const g = this.g;
    return {
      phase: g.phase,
      hand_no: g.handNo,
      totals: g.match.totals,
      first_leader: g.firstLeader,
      exposed: g.exposed,
      trick_no: g.trickNo,
      led_suit: g.ledSuit,
      trick: this.trickView(),
      tricks: g.tricks.map(serializeTrick),
      taken: g.taken,
      cards_left: g.cardsLeft,
      result: g.result,
    };
  }

  private legal(seat: number) {
    const g = this.g;
    if (g.phase === 'expose') return { phase: 'expose', exposable: g.exposable(seat as GzSeat) };
    return { phase: 'playing', cards: g.legalCards() };
  }

  privateView(seat: number) {
    const g = this.g;
    return { hand: g.hands[seat], ...(g.turn === seat && !this.finished ? { legal: this.legal(seat) } : {}) };
  }

  legalMoves(seat: number) {
    const g = this.g;
    if (this.finished || g.turn !== seat) return { cards: [] };
    if (g.phase === 'expose') return { exposable: g.exposable(seat as GzSeat) };
    return { cards: g.legalCards() };
  }

  finishedData() {
    return { result: this.g.result, hands: this.g.hands, seed: this.g.seed };
  }

  resultData() {
    return this.g.result as unknown as Record<string, unknown>;
  }

  outcomes(): PlayerOutcome[] {
    const r = this.g.result!;
    return SEATS.map((seat) => ({ seat, score: r.scores[seat]!, win: r.scores[seat]! > 0, isLandlord: false }));
  }

  replayData() {
    return { seed: this.g.seed, initial_hands: this.g.initialHands };
  }
}

export const gongzhu: GameVariant = {
  type: 'gongzhu',
  seatCount: () => 4,
  minPlayers: () => 4,
  defaultConfig: { play_timeout_ms: 20_000 },
  parseConfig(raw) {
    const out: Record<string, unknown> = {};
    if (raw.play_timeout_ms !== undefined) out.play_timeout_ms = timeoutMs(raw.play_timeout_ms, 'play_timeout_ms');
    return out;
  },
  maxRedeals: 0,
  create(seed, _seats, _config, prev) {
    const p = prev instanceof GongzhuSession && prev.g.result ? prev.g : null;
    return new GongzhuSession(seed, p ? nextGzMatch(p.match, p.result!) : newGzMatch());
  },
};
