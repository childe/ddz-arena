// Smart-bot dispatch: a player seated in a room asks for smart bots to fill empty seats; the bot
// service (sdk/python/smart/service.py, a separate process) polls for these invites and seats its
// bots. The service reports how many bots of each game type are free on every poll, so invites
// beyond that are refused right away.
import { timingSafeEqual } from 'node:crypto';
import { ApiError, badRequest, conflict } from './errors.ts';
import type { GameType } from './games/index.ts';
import type { Room } from './room.ts';

/** Game types the service has smart bots for. */
export const SMART_GAMES: GameType[] = ['ddz', 'ddz4', 'guandan', 'gongzhu'];
/** The service counts as down if it has not polled for this long. */
const ALIVE_MS = 15_000;

export interface SmartInvite {
  id: number;
  room_id: string;
  game: GameType;
  count: number;
}

export class SmartBots {
  private key: Buffer | null;
  private free: Partial<Record<GameType, number>> = {};
  private seenAt = 0;
  private queue: SmartInvite[] = [];
  private nextId = 1;

  constructor(serviceKey: string | undefined) {
    this.key = serviceKey ? Buffer.from(serviceKey) : null;
  }

  get alive(): boolean {
    return this.key !== null && Date.now() - this.seenAt < ALIVE_MS;
  }

  /** Free bots per game type, minus invites the service has not picked up yet. */
  available(game: GameType): number {
    const pending = this.queue.filter((i) => i.game === game).reduce((n, i) => n + i.count, 0);
    return Math.max(0, (this.free[game] ?? 0) - pending);
  }

  status() {
    return {
      available: this.alive,
      free: Object.fromEntries(SMART_GAMES.map((g) => [g, this.alive ? this.available(g) : 0])),
    };
  }

  checkKey(given: unknown) {
    if (!this.key) throw new ApiError(404, 'NOT_FOUND', 'bot service is not configured');
    const g = Buffer.from(typeof given === 'string' ? given : '');
    if (g.length !== this.key.length || !timingSafeEqual(g, this.key)) throw new ApiError(401, 'UNAUTHORIZED', 'bad service key');
  }

  /** Called by the service: record its free bots and hand over pending invites. The free counts
   * were taken before these invites are seated, so they are deducted until the next poll. */
  poll(free: Partial<Record<GameType, number>>): SmartInvite[] {
    this.free = { ...free };
    this.seenAt = Date.now();
    const out = this.queue;
    this.queue = [];
    for (const i of out) this.free[i.game] = Math.max(0, (this.free[i.game] ?? 0) - i.count);
    return out;
  }

  /** Ask for up to `count` bots (default: every empty seat) in `room` on behalf of `botId`. */
  invite(room: Room, botId: string, count: unknown): number {
    const game = room.summary().game as GameType;
    if (!SMART_GAMES.includes(game)) throw badRequest(`smart bots play ${SMART_GAMES.join(', ')}, not ${game}`);
    if (room.seatOf(botId) === null) throw new ApiError(403, 'NOT_SEATED', 'sit in the room before inviting bots');
    const empty = room.seats.filter((s) => s === null).length;
    if (empty === 0) throw conflict('ROOM_FULL', 'the room has no empty seat');
    const want = count === undefined ? empty : count;
    if (typeof want !== 'number' || !Number.isInteger(want) || want < 1) throw badRequest('count must be a positive integer');
    if (!this.alive) throw new ApiError(503, 'BOT_SERVICE_DOWN', 'the smart-bot service is not running');
    const n = Math.min(want, empty, this.available(game));
    if (n === 0) throw conflict('NO_FREE_BOT', `all smart bots for ${game} are busy`);
    this.queue.push({ id: this.nextId++, room_id: room.id, game, count: n });
    return n;
  }
}
