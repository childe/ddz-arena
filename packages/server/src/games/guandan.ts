// Guandan adapter (docs/guandan.md). Each session is one hand; the match state (levels, tribute order)
// is carried from the previous session in the room.
import {
  GuandanGame, GD_PATTERN_TYPES, newMatch, nextMatch, teamOf,
  type Card, type GdHint, type GdPlayRecord, type GdSeat, type GuandanMatch,
} from '@ddz/engine';
import { badRequest } from '../errors.ts';
import { timeoutMs } from './ddz.ts';
import type { ActResult, Emit, GameSession, GameVariant, PlayerOutcome } from './types.ts';

const SEATS = [0, 1, 2, 3];
const serializePlay = (p: GdPlayRecord) => ({ seat: p.seat, cards: p.cards, pattern: p.pattern });

class GuandanSession implements GameSession {
  readonly seats = SEATS;
  readonly g: GuandanGame;

  constructor(seed: string, match: GuandanMatch) {
    this.g = new GuandanGame(seed, match);
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

  private matchView() {
    const m = this.g.match;
    return { hand_no: m.handNo, level: this.g.level, level_team: m.levelTeam, team_levels: m.teamLevels, a_attempts: m.aAttempts };
  }

  startEvents(): Emit[] {
    const g = this.g;
    const priv: Record<number, Record<string, unknown>> = {};
    for (const s of SEATS) priv[s] = { hand: g.initialHands[s] };
    const events: Emit[] = [{ type: 'game.started', data: { ...this.matchView(), cards_left: SEATS.map(() => g.initialHands[0].length) }, priv }];
    if (g.tribute) events.push({ type: 'tribute', data: g.tribute });
    return events;
  }

  private toBeat() {
    const g = this.g;
    return g.phase === 'playing' && g.toBeat && g.lastPlay ? serializePlay(g.lastPlay) : null;
  }

  turnEvent(): Emit {
    const g = this.g;
    return { type: 'turn', data: { seat: g.turn, phase: g.phase, to_beat: this.toBeat(), can_pass: g.phase === 'playing' && g.canPass } };
  }

  turnTimeout(config: Record<string, unknown>) {
    return config.play_timeout_ms as number;
  }

  act(seat: number, op: string, body: Record<string, unknown>): ActResult {
    if (op === 'return') {
      if (typeof body.card !== 'string') throw badRequest('card must be a card code');
      return { events: this.returnCard(seat, body.card, false) };
    }
    if (op === 'play') {
      const { cards, pattern } = body;
      if (!Array.isArray(cards) || cards.some((c) => typeof c !== 'string')) throw badRequest('cards must be an array of card codes');
      let hint: GdHint | undefined;
      if (pattern !== undefined && pattern !== null) {
        const { type, rank } = pattern as { type?: unknown; rank?: unknown };
        if (typeof type !== 'string' || !(GD_PATTERN_TYPES as readonly string[]).includes(type)) throw badRequest('pattern.type is not a known pattern type');
        if (rank !== undefined && typeof rank !== 'string') throw badRequest('pattern.rank must be a rank label');
        hint = { type, rank } as GdHint;
      }
      const events = this.play(seat, cards as Card[], hint, false);
      return { events, reply: { pattern: this.g.history.at(-1)?.pattern ?? null } };
    }
    throw badRequest(`this game uses play and return, not ${op}`);
  }

  private returnCard(seat: number, card: Card, auto: boolean): Emit[] {
    const r = this.g.returnCard(seat as GdSeat, card);
    return [{ type: 'returned', data: { ...r, auto } }];
  }

  private play(seat: number, cards: Card[], hint: GdHint | undefined, auto: boolean): Emit[] {
    const g = this.g;
    const outBefore = g.order.length;
    const pattern = g.play(seat as GdSeat, cards, hint);
    if (!pattern) return [{ type: 'passed', data: { seat, auto } }];
    const events: Emit[] = [{
      type: 'played',
      data: { seat, cards: g.history.at(-1)!.cards, pattern, cards_left: g.cardsLeft, auto },
    }];
    // The engine appends the remaining seats to `order` when the hand ends; only the player who just
    // went out is announced here.
    if (g.order.length > outBefore && g.order[outBefore] === seat) events.push({ type: 'player.out', data: { seat, place: outBefore + 1 } });
    return events;
  }

  auto(seat: number): Emit[] {
    const a = this.g.autoAction();
    return a.kind === 'return' ? this.returnCard(seat, a.card, true) : this.play(seat, a.cards, undefined, true);
  }

  publicView() {
    const g = this.g;
    return {
      phase: g.phase,
      ...this.matchView(),
      tribute: g.tribute,
      returns: g.returns,
      to_beat: this.toBeat(),
      can_pass: g.phase === 'playing' && g.canPass,
      cards_left: g.cardsLeft,
      order: g.result ? g.result.order : g.order,
      history: g.history.map(serializePlay),
      result: g.result,
    };
  }

  private legal(seat: number) {
    const g = this.g;
    if (g.phase === 'return') return { phase: 'return', return_cards: g.returnableCards(seat as GdSeat) };
    return { phase: 'playing', to_beat: this.toBeat(), can_pass: g.canPass };
  }

  privateView(seat: number) {
    const g = this.g;
    return { hand: g.hands[seat], ...(g.turn === seat && !this.finished ? { legal: this.legal(seat) } : {}) };
  }

  legalMoves(seat: number) {
    const g = this.g;
    if (this.finished || g.turn !== seat) return { moves: [], can_pass: false };
    if (g.phase === 'return') return { return_cards: [...new Set(g.returnableCards(seat as GdSeat))] };
    return { moves: g.legalMoves(), can_pass: g.canPass };
  }

  finishedData() {
    return { result: this.g.result, hands: this.g.hands, seed: this.g.seed };
  }

  resultData() {
    return this.g.result as unknown as Record<string, unknown>;
  }

  outcomes(): PlayerOutcome[] {
    const r = this.g.result!;
    return SEATS.map((seat) => ({ seat, score: r.scores[seat]!, win: teamOf(seat as GdSeat) === r.winner_team, isLandlord: false }));
  }

  replayData() {
    return { seed: this.g.seed, initial_hands: this.g.initialHands };
  }
}

export const guandan: GameVariant = {
  type: 'guandan',
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
    const p = prev instanceof GuandanSession && prev.g.result ? prev.g : null;
    return new GuandanSession(seed, p ? nextMatch(p.match, p.result!) : newMatch());
  },
};
