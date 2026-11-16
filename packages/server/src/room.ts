import { randomBytes } from 'node:crypto';
import { GameError } from '@ddz/engine';
import { ApiError, conflict, badRequest } from './errors.ts';
import type { Emit, GameSession, GameType, GameVariant } from './games/index.ts';

/** Options shared by every game type; each variant adds its own (timeouts, seats...). */
export interface RoomConfig {
  legal_moves_api: boolean;
  auto_restart: boolean;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG = { legal_moves_api: true, auto_restart: true };

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
  priv?: Record<number, Record<string, unknown>>;
}

export interface FinishedGame {
  gameId: string;
  roomId: string;
  gameType: GameType;
  session: GameSession;
  /** Indexed by seat; null for seats not in this game. */
  players: (Player | null)[];
  events: RoomEvent[];
  timeouts: number[];
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

export const newId = (prefix: string, bytes = 5) => prefix + randomBytes(bytes).toString('hex');

export class Room {
  readonly id: string;
  readonly variant: GameVariant;
  name: string;
  config: RoomConfig;
  seats: (SeatState | null)[];
  game: GameSession | null = null;
  gameId: string | null = null;
  /** Indexed by seat; null for seats not in the current game. */
  gamePlayers: (Player | null)[] = [];
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
  private timeouts: number[] = [];
  private gameStartedAt = 0;
  private hooks: RoomHooks;

  constructor(name: string, variant: GameVariant, config: Partial<RoomConfig>, hooks: RoomHooks) {
    this.id = newId('r_', 3);
    this.name = name || this.id;
    this.variant = variant;
    this.config = { ...DEFAULT_CONFIG, ...variant.defaultConfig, ...config };
    this.seats = new Array(variant.seatCount(this.config)).fill(null);
    this.hooks = hooks;
    this.emptySince = Date.now();
  }

  // ---------- views ----------

  get status(): 'waiting' | 'playing' {
    return this.game && !this.game.finished ? 'playing' : 'waiting';
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      game: this.variant.type,
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
    const live = !g.finished;
    const { phase, ...view } = g.publicView() as { phase?: unknown };
    return {
      game_id: this.gameId,
      room_id: this.id,
      game: this.variant.type,
      phase: phase ?? (live ? 'playing' : 'finished'),
      players: this.playersView(),
      turn: live ? g.turn : null,
      deadline: live ? this.deadline : null,
      remaining_ms: live ? Math.max(0, this.deadline - Date.now()) : null,
      ...view,
      seq: this.seq,
      turn_seq: this.turnSeq,
    };
  }

  playerGame(seat: number) {
    return { ...this.publicGame(), seat, ...this.game!.privateView(seat) };
  }

  private playersView() {
    return this.gamePlayers.flatMap((p, seat) => (p ? [{ seat, ...p }] : []));
  }

  seatOf(botId: string): number | null {
    const i = this.seats.findIndex((s) => s?.bot_id === botId);
    return i < 0 ? null : i;
  }

  /** The bot's seat in the current game, or -1. */
  gameSeatOf(botId: string): number {
    return this.gamePlayers.findIndex((p) => p?.bot_id === botId);
  }

  /** Buffered events after `since`, or null if the buffer no longer reaches back that far. */
  eventsSince(since: number): RoomEvent[] | null {
    if (since >= this.seq) return [];
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (since + 1 < oldest) return null;
    return this.buffer.filter((e) => e.seq > since);
  }

  // ---------- events ----------

  private emitAll(events: Emit[]): RoomEvent {
    let first: RoomEvent | undefined;
    for (const e of events) {
      const ev = this.emit(e.type, e.data, e.priv);
      first ??= ev;
    }
    return first!;
  }

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

  join(p: Player, seat?: number): number {
    if (this.seatOf(p.bot_id) !== null) return this.seatOf(p.bot_id)!;
    let target: number;
    if (seat === undefined || seat === null) {
      target = this.seats.findIndex((s) => s === null);
      if (target < 0) throw conflict('ROOM_FULL', 'room is full');
    } else {
      if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) throw badRequest(`seat must be 0..${this.seats.length - 1}`);
      if (this.seats[seat]) throw conflict('SEAT_TAKEN', `seat ${seat} is taken`);
      target = seat;
    }
    this.seats[target] = { ...p, ready: false, trustee: false, consecutiveTimeouts: 0, score: 0, left: false };
    this.emptySince = null;
    this.touch();
    return target;
  }

  leave(botId: string) {
    const seat = this.seatOf(botId);
    if (seat === null) return;
    if (this.status === 'playing' && this.gameSeatOf(botId) === seat) {
      this.seats[seat]!.left = true;
      this.seats[seat]!.ready = false;
      this.touch();
      // If it's their turn, act for them right away.
      if (this.game!.turn === seat) this.schedule(500);
      return;
    }
    if (this.status === 'playing') {
      // Seated but not in this game (e.g. joined a poker table mid-hand): just free the seat.
      this.seats[seat] = null;
      this.touch();
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
    const seated = this.seats.filter((s) => s !== null);
    if (seated.length < this.variant.minPlayers(this.config) || !seated.every((s) => s.ready && !s.left)) return;
    this.startGame();
  }

  private cancelRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // ---------- game lifecycle ----------

  private startGame() {
    this.cancelRestart();
    const seats = this.seats.flatMap((s, i) => (s ? [i] : []));
    const prev = this.game;
    this.game = this.variant.create(randomBytes(16).toString('hex'), seats, this.config, prev);
    this.gameId = newId('g_', 6);
    this.gamePlayers = this.seats.map((s) => s && { bot_id: s.bot_id, name: s.name, kind: s.kind });
    this.gameEvents = [];
    this.timeouts = new Array(this.seats.length).fill(0);
    this.illegalCount = 0;
    this.gameStartedAt = Date.now();
    this.hooks.gameStarted(this, this.gameId);
    for (const e of this.game.startEvents()) {
      this.emit(e.type, e.type === 'game.started' ? { game: this.variant.type, players: this.playersView(), ...e.data } : e.data, e.priv);
    }
    this.touch();
    this.nextTurn();
  }

  private timeoutFor(seat: number): number {
    const s = this.seats[seat];
    if (s?.left) return 500;
    if (s?.trustee) return TRUSTEE_TIMEOUT_MS;
    return this.game!.turnTimeout(this.config);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onTimeout(), ms);
  }

  private nextTurn() {
    const g = this.game!;
    this.illegalCount = 0;
    const ms = this.timeoutFor(g.turn!);
    this.deadline = Date.now() + ms;
    this.schedule(ms);
    const t = g.turnEvent();
    const { seat, ...rest } = t.data;
    const ev = this.emit(t.type, { seat, deadline: this.deadline, remaining_ms: ms, ...rest }, t.priv);
    this.turnSeq = ev.seq;
  }

  private onTimeout() {
    this.timer = null;
    const g = this.game;
    if (!g || g.finished) return;
    const seat = g.turn!;
    const s = this.seats[seat]!;
    if (!s.left) {
      this.timeouts[seat]++;
      s.consecutiveTimeouts++;
      if (s.consecutiveTimeouts >= TRUSTEE_AFTER && !s.trustee) {
        s.trustee = true;
        this.touch();
      }
    }
    this.emitAll(g.auto(seat));
    this.advance();
  }

  private checkTurn(botId: string, seq: unknown): number {
    const g = this.game;
    if (!g || g.finished) throw conflict('WRONG_PHASE', 'no game in progress');
    const seat = this.gameSeatOf(botId);
    if (seat < 0) throw new ApiError(403, 'NOT_A_PLAYER', 'you are not a player in this game');
    if (seq !== undefined && seq !== null) {
      if (typeof seq !== 'number' || !Number.isInteger(seq)) throw badRequest('seq must be an integer');
      if (g.turn === seat && seq < this.turnSeq) {
        throw conflict('STALE_SEQ', `seq ${seq} is older than the current turn (${this.turnSeq})`, { turn_seq: this.turnSeq });
      }
    }
    return seat;
  }

  /** Count an illegal request; too many in one turn forces the timeout action. */
  private illegal(e: GameError, seat: number): never {
    if (this.game!.turn === seat && e.status === 422) {
      this.illegalCount++;
      if (this.illegalCount > MAX_ILLEGAL) setImmediate(() => this.onTimeout());
    }
    throw e;
  }

  private ownAction(seat: number) {
    const s = this.seats[seat]!;
    s.consecutiveTimeouts = 0;
    if (s.trustee) {
      s.trustee = false;
      this.touch();
    }
  }

  /** A player action from the API: `op` is bid / play / action. */
  act(botId: string, op: string, body: Record<string, unknown>) {
    const seat = this.checkTurn(botId, body.seq);
    let res;
    try {
      res = this.game!.act(seat, op, body);
    } catch (e) {
      if (e instanceof GameError) this.illegal(e, seat);
      throw e;
    }
    this.ownAction(seat);
    const ev = this.emitAll(res.events);
    this.advance();
    return { ok: true, seq: ev.seq, ...res.reply };
  }

  /** After an action: next turn, redeal or finish. */
  private advance() {
    const g = this.game!;
    if (!g.finished) return this.nextTurn();
    if (g.redeal) {
      this.redeals++;
      if (this.redeals < this.variant.maxRedeals) {
        if (this.timer) clearTimeout(this.timer);
        this.emit('redeal', { count: this.redeals });
        this.startGame();
        return;
      }
    }
    this.finish();
  }

  legalMoves(botId: string) {
    if (!this.config.legal_moves_api) throw new ApiError(403, 'LEGAL_MOVES_DISABLED', 'legal-moves API is disabled in this room');
    const seat = this.gameSeatOf(botId);
    if (seat < 0) throw new ApiError(403, 'NOT_A_PLAYER', 'you are not a player in this game');
    const g = this.game;
    if (!g || g.finished) return { moves: [], can_pass: false };
    return g.legalMoves(seat);
  }

  private finish() {
    const g = this.game!;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.redeals = 0;
    this.emit('game.finished', g.finishedData());
    this.gamesPlayed++;
    for (const o of g.outcomes()) {
      const s = this.seats[o.seat];
      if (s && s.bot_id === this.gamePlayers[o.seat]?.bot_id) s.score += o.score;
    }
    this.hooks.gameFinished(this, {
      gameId: this.gameId!, roomId: this.id, gameType: this.variant.type, session: g, players: this.gamePlayers, events: this.gameEvents,
      timeouts: this.timeouts, startedAt: this.gameStartedAt, finishedAt: Date.now(), publicView: this.publicGame()!,
    });
    // Free seats of players who left mid-game.
    for (let i = 0; i < this.seats.length; i++) {
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
