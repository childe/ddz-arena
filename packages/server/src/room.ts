import { randomBytes } from 'node:crypto';
import {
  Game, GameError, legalMoves, RANK_LABELS, PATTERN_TYPES,
  type Card, type Pattern, type PatternType, type PlayRecord, type Seat, type GameResult,
} from '@ddz/engine';
import { ApiError, conflict, badRequest } from './errors.ts';

export interface RoomConfig {
  bid_timeout_ms: number;
  play_timeout_ms: number;
  legal_moves_api: boolean;
  auto_restart: boolean;
}

export const DEFAULT_CONFIG: RoomConfig = {
  bid_timeout_ms: 10_000,
  play_timeout_ms: 20_000,
  legal_moves_api: true,
  auto_restart: true,
};

export const TRUSTEE_TIMEOUT_MS = 2_000;
const TRUSTEE_AFTER = 3;
const MAX_ILLEGAL = 5;
const MAX_REDEALS = 3;
const RESTART_DELAY_MS = 3_000;
const BUFFER_SIZE = 2_000;

export interface Player {
  bot_id: string;
  name: string;
  kind: 'bot' | 'human';
}

interface SeatState extends Player {
  ready: boolean;
  trustee: boolean;
  consecutiveTimeouts: number;
  score: number;
  /** Left during a game: auto-played until the game ends, then the seat is freed. */
  left: boolean;
  /** Unreadied because it had no WebSocket when a game ended; becomes ready again on reconnect. */
  awayUnready?: boolean;
}

export interface RoomEvent {
  seq: number;
  type: string;
  ts: number;
  room_id: string;
  game_id: string | null;
  data: Record<string, unknown>;
  /** Extra data merged into `data` only for the player in that seat. */
  priv?: Partial<Record<Seat, Record<string, unknown>>>;
}

export interface FinishedGame {
  gameId: string;
  roomId: string;
  game: Game;
  players: Player[];
  events: RoomEvent[];
  timeouts: [number, number, number];
  startedAt: number;
  finishedAt: number;
  publicView: Record<string, unknown>;
}

export interface RoomHooks {
  /** Deliver an event to everyone subscribed to the room. */
  broadcast(room: Room, event: RoomEvent): void;
  gameStarted(room: Room, gameId: string): void;
  gameFinished(room: Room, finished: FinishedGame): void;
}

export const serializePattern = (p: Pattern | null) =>
  p && { type: p.type, rank: RANK_LABELS[p.main], length: p.length };
export const serializePlay = (p: PlayRecord) => ({ seat: p.seat, cards: p.cards, pattern: serializePattern(p.pattern) });

export function serializeResult(r: GameResult | null) {
  if (!r) return null;
  return {
    kind: r.kind, winner: r.winner, winner_seat: r.winnerSeat, landlord: r.landlord, base: r.base, bombs: r.bombs,
    spring: r.spring, anti_spring: r.antiSpring, multiplier: r.multiplier, scores: r.scores,
  };
}

export const newId = (prefix: string, bytes = 5) => prefix + randomBytes(bytes).toString('hex');

export class Room {
  readonly id: string;
  name: string;
  config: RoomConfig;
  seats: (SeatState | null)[] = [null, null, null];
  game: Game | null = null;
  gameId: string | null = null;
  gamePlayers: Player[] = [];
  gamesPlayed = 0;
  seq = 0;
  turnSeq = 0;
  deadline = 0;
  emptySince: number | null;
  /** Connected spectator count, maintained by the arena. */
  spectators = 0;
  /** Returns how many player sockets a bot has open; set by the arena. */
  isConnected: (botId: string) => boolean = () => false;

  private buffer: RoomEvent[] = [];
  private gameEvents: RoomEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private illegalCount = 0;
  private redeals = 0;
  private timeouts: [number, number, number] = [0, 0, 0];
  private gameStartedAt = 0;
  private hooks: RoomHooks;

  constructor(name: string, config: Partial<RoomConfig>, hooks: RoomHooks) {
    this.id = newId('r_', 3);
    this.name = name || this.id;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.hooks = hooks;
    this.emptySince = Date.now();
  }

  // ---------- views ----------

  get status(): 'waiting' | 'playing' {
    return this.game && this.game.phase !== 'finished' ? 'playing' : 'waiting';
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      seats: this.seats.map((s, i) => s && {
        seat: i, bot_id: s.bot_id, name: s.name, kind: s.kind, ready: s.ready,
        connected: this.isConnected(s.bot_id), trustee: s.trustee || s.left, score: s.score,
      }),
      spectators: this.spectators,
      game_id: this.status === 'playing' ? this.gameId : null,
      games_played: this.gamesPlayed,
      config: this.config,
    };
  }

  publicGame(): Record<string, unknown> | null {
    const g = this.game;
    if (!g || !this.gameId) return null;
    const live = g.phase !== 'finished';
    const toBeat = g.phase === 'playing' ? g.toBeat : null;
    return {
      game_id: this.gameId,
      room_id: this.id,
      phase: g.phase,
      players: this.gamePlayers.map((p, seat) => ({ seat, ...p })),
      first_bidder: g.firstBidder,
      bids: g.bids,
      high_bid: g.highBid,
      landlord: g.landlord,
      bottom: g.landlord === null ? null : g.bottom,
      turn: live ? g.turn : null,
      deadline: live ? this.deadline : null,
      remaining_ms: live ? Math.max(0, this.deadline - Date.now()) : null,
      to_beat: toBeat && g.lastPlay ? serializePlay(g.lastPlay) : null,
      can_pass: g.phase === 'playing' && toBeat !== null,
      cards_left: g.hands.map((h) => h.length),
      multiplier: g.multiplier,
      history: g.history.map(serializePlay),
      result: serializeResult(g.result),
      seq: this.seq,
      turn_seq: this.turnSeq,
    };
  }

  playerGame(seat: Seat) {
    return { ...this.publicGame(), seat, hand: this.game!.hands[seat] };
  }

  seatOf(botId: string): Seat | null {
    const i = this.seats.findIndex((s) => s?.bot_id === botId);
    return i < 0 ? null : (i as Seat);
  }

  /** Buffered events after `since`, or null if the buffer no longer reaches back that far. */
  eventsSince(since: number): RoomEvent[] | null {
    if (since >= this.seq) return [];
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (since + 1 < oldest) return null;
    return this.buffer.filter((e) => e.seq > since);
  }

  // ---------- events ----------

  private emit(type: string, data: Record<string, unknown>, priv?: RoomEvent['priv']): RoomEvent {
    const ev: RoomEvent = { seq: ++this.seq, type, ts: Date.now(), room_id: this.id, game_id: this.gameId, data };
    if (priv) ev.priv = priv;
    this.buffer.push(ev);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.splice(0, this.buffer.length - BUFFER_SIZE);
    if (this.game && type !== 'room.updated') this.gameEvents.push(ev);
    this.hooks.broadcast(this, ev);
    return ev;
  }

  touch() {
    this.emit('room.updated', { room: this.summary() });
  }

  // ---------- seating ----------

  join(p: Player, seat?: number): Seat {
    if (this.seatOf(p.bot_id) !== null) return this.seatOf(p.bot_id)!;
    let target: number;
    if (seat === undefined || seat === null) {
      target = this.seats.findIndex((s) => s === null);
      if (target < 0) throw conflict('ROOM_FULL', 'room is full');
    } else {
      if (![0, 1, 2].includes(seat)) throw badRequest('seat must be 0, 1 or 2');
      if (this.seats[seat]) throw conflict('SEAT_TAKEN', `seat ${seat} is taken`);
      target = seat;
    }
    this.seats[target] = { ...p, ready: false, trustee: false, consecutiveTimeouts: 0, score: 0, left: false };
    this.emptySince = null;
    this.touch();
    return target as Seat;
  }

  leave(botId: string) {
    const seat = this.seatOf(botId);
    if (seat === null) return;
    if (this.status === 'playing') {
      this.seats[seat]!.left = true;
      this.seats[seat]!.ready = false;
      this.touch();
      // If it's their turn, act for them right away.
      if (this.game!.turn === seat) this.schedule(500);
      return;
    }
    this.seats[seat] = null;
    if (this.seats.every((s) => s === null)) this.emptySince = Date.now();
    this.cancelRestart();
    this.touch();
  }

  /** A seated bot's first WebSocket connected: re-ready it if a game ended while it was away. */
  reconnected(botId: string) {
    const seat = this.seatOf(botId);
    const s = seat === null ? null : this.seats[seat];
    if (s?.awayUnready) this.setReady(botId, true);
  }

  setReady(botId: string, ready: boolean) {
    const seat = this.seatOf(botId);
    if (seat === null) throw conflict('NOT_IN_ROOM', 'you are not seated in this room');
    this.seats[seat]!.ready = ready;
    this.seats[seat]!.awayUnready = false;
    this.touch();
    this.maybeStart();
  }

  private maybeStart() {
    if (this.status === 'playing' || this.restartTimer) return;
    if (!this.seats.every((s) => s && s.ready && !s.left)) return;
    this.startGame();
  }

  private cancelRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // ---------- game lifecycle ----------

  private startGame() {
    this.cancelRestart();
    this.game = new Game(randomBytes(16).toString('hex'));
    this.gameId = newId('g_', 6);
    this.gamePlayers = this.seats.map((s) => ({ bot_id: s!.bot_id, name: s!.name, kind: s!.kind }));
    this.gameEvents = [];
    this.timeouts = [0, 0, 0];
    this.illegalCount = 0;
    this.gameStartedAt = Date.now();
    this.hooks.gameStarted(this, this.gameId);
    const g = this.game;
    this.emit(
      'game.started',
      { players: this.gamePlayers.map((p, seat) => ({ seat, ...p })), first_bidder: g.firstBidder, cards_left: [17, 17, 17] },
      { 0: { hand: g.hands[0] }, 1: { hand: g.hands[1] }, 2: { hand: g.hands[2] } },
    );
    this.touch();
    this.nextTurn();
  }

  private timeoutFor(seat: Seat): number {
    const s = this.seats[seat];
    if (s?.left) return 500;
    if (s?.trustee) return TRUSTEE_TIMEOUT_MS;
    return this.game!.phase === 'bidding' ? this.config.bid_timeout_ms : this.config.play_timeout_ms;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onTimeout(), ms);
  }

  private nextTurn() {
    const g = this.game!;
    this.illegalCount = 0;
    const ms = this.timeoutFor(g.turn);
    this.deadline = Date.now() + ms;
    this.schedule(ms);
    const base = { seat: g.turn, deadline: this.deadline, remaining_ms: ms };
    const ev = g.phase === 'bidding'
      ? this.emit('bid.turn', { ...base, high_bid: g.highBid })
      : this.emit('turn', { ...base, to_beat: g.toBeat && g.lastPlay ? serializePlay(g.lastPlay) : null, can_pass: g.toBeat !== null });
    this.turnSeq = ev.seq;
  }

  private onTimeout() {
    this.timer = null;
    const g = this.game;
    if (!g || g.phase === 'finished') return;
    const seat = g.turn;
    const s = this.seats[seat]!;
    if (!s.left) {
      this.timeouts[seat]++;
      s.consecutiveTimeouts++;
      if (s.consecutiveTimeouts >= TRUSTEE_AFTER && !s.trustee) {
        s.trustee = true;
        this.touch();
      }
    }
    const a = g.autoAction();
    if (a.kind === 'bid') this.applyBid(seat, a.score, true);
    else this.applyPlay(seat, a.cards, undefined, true);
  }

  private checkTurn(botId: string, seq: unknown): Seat {
    const g = this.game;
    if (!g || g.phase === 'finished') throw conflict('WRONG_PHASE', 'no game in progress');
    const seat = this.gamePlayers.findIndex((p) => p.bot_id === botId);
    if (seat < 0) throw new ApiError(403, 'NOT_A_PLAYER', 'you are not a player in this game');
    if (seq !== undefined && seq !== null) {
      if (typeof seq !== 'number' || !Number.isInteger(seq)) throw badRequest('seq must be an integer');
      if (g.turn === seat && seq < this.turnSeq) {
        throw conflict('STALE_SEQ', `seq ${seq} is older than the current turn (${this.turnSeq})`, { turn_seq: this.turnSeq });
      }
    }
    return seat as Seat;
  }

  /** Count an illegal request; too many in one turn forces the timeout action. */
  private illegal(e: GameError, seat: Seat): never {
    if (this.game!.turn === seat && e.status === 422) {
      this.illegalCount++;
      if (this.illegalCount > MAX_ILLEGAL) setImmediate(() => this.onTimeout());
    }
    throw e;
  }

  private ownAction(seat: Seat) {
    const s = this.seats[seat]!;
    s.consecutiveTimeouts = 0;
    if (s.trustee) {
      s.trustee = false;
      this.touch();
    }
  }

  bid(botId: string, score: unknown, seq: unknown) {
    const seat = this.checkTurn(botId, seq);
    if (typeof score !== 'number') throw new GameError('BAD_BID', 'score must be 0, 1, 2 or 3');
    try {
      this.game!.bid(seat, score);
    } catch (e) {
      if (e instanceof GameError) this.illegal(e, seat);
      throw e;
    }
    this.ownAction(seat);
    return this.afterBid(seat, score, false);
  }

  private applyBid(seat: Seat, score: number, auto: boolean) {
    this.game!.bid(seat, score);
    this.afterBid(seat, score, auto);
  }

  private afterBid(seat: Seat, score: number, auto: boolean) {
    const g = this.game!;
    const ev = this.emit('bid.made', { seat, score, auto });
    if (g.phase === 'finished') {
      this.redeals++;
      if (this.redeals < MAX_REDEALS) {
        this.emit('redeal', { count: this.redeals });
        this.startGame();
      } else {
        this.finish();
      }
    } else {
      if (g.phase === 'playing') this.emit('landlord.decided', { landlord: g.landlord, bottom: g.bottom, high_bid: g.highBid });
      this.nextTurn();
    }
    return { ok: true, seq: ev.seq };
  }

  play(botId: string, cards: unknown, pattern: unknown, seq: unknown) {
    const seat = this.checkTurn(botId, seq);
    if (!Array.isArray(cards) || cards.some((c) => typeof c !== 'string')) throw badRequest('cards must be an array of card codes');
    let hint: PatternType | undefined;
    if (pattern !== undefined && pattern !== null) {
      const t = (pattern as { type?: unknown }).type;
      if (typeof t !== 'string' || !PATTERN_TYPES.includes(t as PatternType)) throw badRequest('pattern.type is not a known pattern type');
      hint = t as PatternType;
    }
    let ev: RoomEvent;
    try {
      ev = this.applyPlay(seat, cards as Card[], hint, false);
    } catch (e) {
      if (e instanceof GameError) this.illegal(e, seat);
      throw e;
    }
    this.ownAction(seat);
    const last = this.game?.history.at(-1);
    return { ok: true, seq: ev.seq, pattern: serializePattern(last?.pattern ?? null) };
  }

  private applyPlay(seat: Seat, cards: Card[], hint: PatternType | undefined, auto: boolean): RoomEvent {
    const g = this.game!;
    const pattern = g.play(seat, cards, hint);
    const ev = pattern
      ? this.emit('played', {
        seat, cards: g.history.at(-1)!.cards, pattern: serializePattern(pattern),
        cards_left: g.hands.map((h) => h.length), multiplier: g.multiplier, auto,
      })
      : this.emit('passed', { seat, auto });
    if (g.phase === 'finished') this.finish();
    else this.nextTurn();
    return ev;
  }

  legalMoves(botId: string) {
    if (!this.config.legal_moves_api) throw new ApiError(403, 'LEGAL_MOVES_DISABLED', 'legal-moves API is disabled in this room');
    const g = this.game;
    const seat = this.gamePlayers.findIndex((p) => p.bot_id === botId);
    if (seat < 0) throw new ApiError(403, 'NOT_A_PLAYER', 'you are not a player in this game');
    if (!g || g.phase !== 'playing' || g.turn !== seat) return { moves: [], can_pass: false };
    const moves = legalMoves(g.hands[seat], g.toBeat).map((m) => ({ cards: m.cards, pattern: serializePattern(m.pattern) }));
    return { moves, can_pass: g.toBeat !== null };
  }

  private finish() {
    const g = this.game!;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.redeals = 0;
    const result = g.result!;
    this.emit('game.finished', { result: serializeResult(result), hands: g.hands, seed: g.seed });
    this.gamesPlayed++;
    for (let i = 0; i < 3; i++) {
      const s = this.seats[i];
      if (!s) continue;
      if (s.bot_id === this.gamePlayers[i]!.bot_id) s.score += result.scores[i]!;
    }
    this.hooks.gameFinished(this, {
      gameId: this.gameId!, roomId: this.id, game: g, players: this.gamePlayers, events: this.gameEvents,
      timeouts: this.timeouts, startedAt: this.gameStartedAt, finishedAt: Date.now(), publicView: this.publicGame()!,
    });
    // Free seats of players who left mid-game.
    for (let i = 0; i < 3; i++) {
      const s = this.seats[i];
      if (s?.left) this.seats[i] = null;
      else if (s && !this.config.auto_restart) s.ready = false;
      else if (s && !this.isConnected(s.bot_id)) {
        // Don't keep auto-playing for bots that went away; resume when they reconnect.
        s.ready = false;
        s.awayUnready = true;
      }
    }
    if (this.seats.every((s) => s === null)) this.emptySince = Date.now();
    this.touch();
    if (this.config.auto_restart) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.maybeStart();
      }, RESTART_DELAY_MS);
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.cancelRestart();
  }
}
