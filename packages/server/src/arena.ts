import { createHash, randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { Db, type BotRow, type GameFilter } from './db.ts';
import { ApiError, conflict, notFound, badRequest } from './errors.ts';
import { Room, newId, type RoomConfig, type RoomEvent, type FinishedGame, type Player } from './room.ts';
import { variantOf, type GameVariant } from './games/index.ts';

const ROOM_IDLE_MS = 10 * 60_000;
const NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

export interface Viewer {
  socket: WebSocket;
  /** Set for player sockets; undefined for spectators. */
  botId?: string;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class Arena {
  db: Db;
  inviteCode: string | undefined;
  rooms = new Map<string, Room>();
  private botRoom = new Map<string, string>();
  private gameRoom = new Map<string, string>();
  private players = new Map<string, Set<WebSocket>>();
  private spectators = new Map<string, Set<WebSocket>>();
  private tokenCache = new Map<string, BotRow>();
  private sweeper: NodeJS.Timeout;

  constructor(db: Db, inviteCode?: string) {
    this.db = db;
    this.inviteCode = inviteCode || undefined;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  close() {
    clearInterval(this.sweeper);
    for (const r of this.rooms.values()) r.dispose();
  }

  // ---------- accounts ----------

  register(name: unknown, kind: 'bot' | 'human', invite?: unknown) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw badRequest('name must be 1-24 letters, digits, CJK characters, "-" or "_"');
    }
    if (kind === 'bot' && this.inviteCode && invite !== this.inviteCode) throw new ApiError(403, 'BAD_INVITE', 'invalid invite code');
    if (this.db.botByName(name)) throw conflict('NAME_TAKEN', `name "${name}" is taken`);
    const token = 'ddz_' + randomBytes(24).toString('base64url');
    const row: BotRow = { id: newId('b_', 4), name, kind, token_hash: hashToken(token), created_at: Date.now() };
    this.db.insertBot(row);
    return { bot_id: row.id, name, kind, token };
  }

  authenticate(token: string | undefined): BotRow {
    if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'missing bearer token');
    const hash = hashToken(token);
    let bot = this.tokenCache.get(hash);
    if (!bot) {
      bot = this.db.botByTokenHash(hash);
      if (!bot) throw new ApiError(401, 'UNAUTHORIZED', 'invalid token');
      this.tokenCache.set(hash, bot);
    }
    return bot;
  }

  me(bot: BotRow) {
    const room = this.roomOfBot(bot.id);
    return {
      bot_id: bot.id, name: bot.name, kind: bot.kind,
      room_id: room?.id ?? null, game: room?.variant.type ?? null, seat: room?.seatOf(bot.id) ?? null, game_id: room?.status === 'playing' && room.gameSeatOf(bot.id) >= 0 ? room.gameId : null,
    };
  }

  // ---------- rooms ----------

  createRoom(name: unknown, config: unknown, game?: unknown): Room {
    if (name !== undefined && (typeof name !== 'string' || name.length > 40)) throw badRequest('name must be a string up to 40 chars');
    const variant = variantOf(game);
    const room = new Room(name as string, variant, parseConfig(config, variant), {
      broadcast: (r, ev) => this.broadcast(r, ev),
      gameStarted: (r, gid) => this.gameRoom.set(gid, r.id),
      gameFinished: (r, f) => this.persist(f),
    });
    room.isConnected = (botId) => (this.players.get(botId)?.size ?? 0) > 0;
    this.rooms.set(room.id, room);
    return room;
  }

  room(id: string): Room {
    const r = this.rooms.get(id);
    if (!r) throw notFound('room');
    return r;
  }

  roomOfBot(botId: string): Room | undefined {
    const id = this.botRoom.get(botId);
    return id ? this.rooms.get(id) : undefined;
  }

  join(bot: BotRow, room: Room, seat?: number): number {
    const current = this.roomOfBot(bot.id);
    if (current && current !== room && current.seatOf(bot.id) !== null) {
      throw conflict('ALREADY_IN_ROOM', `you are already seated in room ${current.id}`, { room_id: current.id });
    }
    const s = room.join(toPlayer(bot), seat);
    this.botRoom.set(bot.id, room.id);
    this.resendRoomTo(bot.id, room);
    return s;
  }

  quickJoin(bot: BotRow, game?: unknown): { room: Room; seat: number } {
    const current = this.roomOfBot(bot.id);
    if (current && current.seatOf(bot.id) !== null) return { room: current, seat: current.seatOf(bot.id)! };
    const type = variantOf(game).type;
    const candidates = [...this.rooms.values()].filter((r) => r.variant.type === type && r.status === 'waiting' && r.seats.some((s) => s === null));
    const room = candidates.find((r) => r.seats.some((s) => s !== null)) ?? candidates[0] ?? this.createRoom(undefined, undefined, type);
    return { room, seat: this.join(bot, room) };
  }

  leave(bot: BotRow, room: Room) {
    if (room.seatOf(bot.id) === null) throw conflict('NOT_IN_ROOM', 'you are not seated in this room');
    room.leave(bot.id);
    if (room.seatOf(bot.id) === null && this.botRoom.get(bot.id) === room.id) this.botRoom.delete(bot.id);
  }

  /** Room hosting game `gid` while that game is the room's current one. */
  liveGameRoom(gid: string): Room | undefined {
    const rid = this.gameRoom.get(gid);
    const room = rid ? this.rooms.get(rid) : undefined;
    return room && room.gameId === gid ? room : undefined;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, r] of this.rooms) {
      if (r.emptySince !== null && r.status === 'waiting' && now - r.emptySince > ROOM_IDLE_MS && !this.spectators.get(id)?.size) {
        r.dispose();
        this.rooms.delete(id);
        if (r.gameId) this.gameRoom.delete(r.gameId);
      }
    }
  }

  // ---------- games ----------

  private persist(f: FinishedGame) {
    const g = f.session;
    const replay = { ...f.publicView, ...g.replayData(), events: f.events.map(publicEvent) };
    this.db.insertGame(
      {
        id: f.gameId, room_id: f.roomId, game_type: f.gameType, seed: g.seed, players: JSON.stringify(f.players),
        result: JSON.stringify(g.resultData()), replay: JSON.stringify(replay), started_at: f.startedAt, finished_at: f.finishedAt,
      },
      g.outcomes().map((o) => ({
        bot_id: f.players[o.seat]!.bot_id, seat: o.seat, is_landlord: o.isLandlord ? 1 : 0, score: o.score,
        win: o.win ? 1 : 0, timeouts: f.timeouts[o.seat]!,
      })),
    );
  }

  publicGame(gid: string) {
    const live = this.liveGameRoom(gid);
    if (live) return live.publicGame();
    const row = this.db.game(gid);
    if (!row) throw notFound('game');
    const { events: _e, seed: _s, initial_hands: _h, holes: _o, deck: _d, ...view } = JSON.parse(row.replay);
    return view;
  }

  replay(gid: string) {
    const live = this.liveGameRoom(gid);
    if (live && live.status === 'playing') throw conflict('GAME_IN_PROGRESS', 'replay is available after the game ends');
    const row = this.db.game(gid);
    if (!row) throw notFound('game');
    return JSON.parse(row.replay);
  }

  recentGames(limit: number, filter: GameFilter = {}) {
    return this.db.recentGames(limit, filter).map((g) => ({
      game_id: g.id, room_id: g.room_id, game: g.game_type,
      players: (JSON.parse(g.players) as (Player | null)[]).flatMap((p, seat) => (p ? [{ seat, ...p }] : [])), result: JSON.parse(g.result),
      started_at: g.started_at, finished_at: g.finished_at,
    }));
  }

  // ---------- sockets ----------

  addPlayerSocket(botId: string, ws: WebSocket) {
    let set = this.players.get(botId);
    if (!set) this.players.set(botId, (set = new Set()));
    set.add(ws);
    const room = this.roomOfBot(botId);
    if (set.size === 1 && room) {
      room.reconnected(botId);
      room.touch();
    }
  }

  removePlayerSocket(botId: string, ws: WebSocket) {
    const set = this.players.get(botId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.players.delete(botId);
      this.roomOfBot(botId)?.touch();
    }
  }

  addSpectator(room: Room, ws: WebSocket) {
    let set = this.spectators.get(room.id);
    if (!set) this.spectators.set(room.id, (set = new Set()));
    set.add(ws);
    room.spectators = set.size;
    room.touch();
  }

  removeSpectator(roomId: string, ws: WebSocket) {
    const set = this.spectators.get(roomId);
    if (!set) return;
    set.delete(ws);
    const room = this.rooms.get(roomId);
    if (room) {
      room.spectators = set.size;
      room.touch();
    }
  }

  private broadcast(room: Room, ev: RoomEvent) {
    const pub = JSON.stringify(publicEvent(ev));
    for (const ws of this.spectators.get(room.id) ?? []) send(ws, pub);
    room.seats.forEach((s, seat) => {
      if (!s) return;
      const sockets = this.players.get(s.bot_id);
      if (!sockets?.size) return;
      // Private data goes to the seat's occupant only if they are the player of the current game.
      const mine = ev.priv?.[seat] && (ev.game_id === null || room.gamePlayers[seat]?.bot_id === s.bot_id);
      const msg = mine ? JSON.stringify(personalize(ev, seat)) : pub;
      for (const ws of sockets) send(ws, msg);
    });
  }

  /** On join, give the bot's sockets the current room snapshot. */
  private resendRoomTo(botId: string, room: Room) {
    for (const ws of this.players.get(botId) ?? []) {
      send(ws, JSON.stringify({ type: 'hello', seq: null, ts: Date.now(), room_id: room.id, game_id: room.gameId, data: { bot_id: botId, room_id: room.id, seq: room.seq } }));
    }
  }

  /** Events for a reconnecting socket; null means the client must resync via /state. */
  backlog(room: Room, since: number, seat: number | null): string[] | null {
    const evs = room.eventsSince(since);
    if (!evs) return null;
    return evs.map((e) => JSON.stringify(seat !== null && e.priv?.[seat] ? personalize(e, seat) : publicEvent(e)));
  }
}

function send(ws: WebSocket, msg: string) {
  if (ws.readyState === 1) ws.send(msg);
}

export function publicEvent(ev: RoomEvent) {
  const { priv: _p, ...rest } = ev;
  return rest;
}

function personalize(ev: RoomEvent, seat: number) {
  const { priv, ...rest } = ev;
  return { ...rest, data: { ...rest.data, ...priv?.[seat] } };
}

const toPlayer = (b: BotRow): Player => ({ bot_id: b.id, name: b.name, kind: b.kind });

function parseConfig(raw: unknown, variant: GameVariant): Partial<RoomConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('config must be an object');
  const c = raw as Record<string, unknown>;
  const out: Partial<RoomConfig> = variant.parseConfig(c);
  for (const k of ['legal_moves_api', 'auto_restart'] as const) {
    if (c[k] === undefined) continue;
    if (typeof c[k] !== 'boolean') throw badRequest(`${k} must be a boolean`);
    out[k] = c[k] as boolean;
  }
  return out;
}
