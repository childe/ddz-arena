import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GameError } from '@ddz/engine';
import type { WebSocket } from 'ws';
import { Arena } from './arena.ts';
import { Db, type BotRow } from './db.ts';
import { ApiError, badRequest } from './errors.ts';
import { variantOf } from './games/index.ts';

export interface AppOptions {
  dbPath: string;
  inviteCode?: string;
  webDir?: string;
  docsPath?: string;
  rateLimit?: number;
  logger?: boolean;
}

const PING_MS = 20_000;

/** Token bucket per bot: refills `rate` per second, bursts up to 2x. */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private rate: number;
  constructor(rate: number) {
    this.rate = rate;
  }
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.rate * 2, at: now };
    b.tokens = Math.min(this.rate * 2, b.tokens + ((now - b.at) / 1000) * this.rate);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

function errorBody(e: ApiError | GameError) {
  return { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; arena: Arena }> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  const arena = new Arena(new Db(opts.dbPath), opts.inviteCode);
  const limiter = new RateLimiter(opts.rateLimit ?? 50);
  app.addHook('onClose', async () => arena.close());

  // Accept empty JSON bodies (e.g. `curl -X POST -H 'content-type: application/json'`).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(badRequest('invalid JSON body'), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError || err instanceof GameError) return reply.status(err.status).send(errorBody(err));
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `route ${req.method} ${req.url.split('?')[0]} not found` } });
    }
    if (opts.webDir && existsSync(`${opts.webDir}/index.html`)) return reply.sendFile('index.html');
    return reply.status(404).send('not found');
  });

  const tokenOf = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
  };
  const auth = (req: FastifyRequest): BotRow => {
    const token = tokenOf(req);
    const bot = arena.authenticate(token);
    if (!limiter.take(bot.id)) throw new ApiError(429, 'RATE_LIMITED', 'too many requests');
    return bot;
  };
  const body = (req: FastifyRequest) => {
    const b = req.body ?? {};
    if (typeof b !== 'object' || Array.isArray(b)) throw badRequest('body must be a JSON object');
    return b as Record<string, unknown>;
  };
  type P = { Params: { rid: string; gid: string } };

  await app.register(websocket);
  if (opts.webDir && existsSync(opts.webDir)) await app.register(fastifyStatic, { root: opts.webDir, wildcard: false });

  // ---------- accounts ----------
  app.post('/api/v1/bots', async (req, reply) => {
    const b = body(req);
    reply.status(201);
    return arena.register(b.name, 'bot', b.invite_code);
  });
  app.post('/api/v1/guests', async (req, reply) => {
    reply.status(201);
    return arena.register(body(req).name, 'human');
  });
  app.get('/api/v1/me', async (req) => arena.me(auth(req)));

  // ---------- rooms ----------
  app.get('/api/v1/rooms', async () => ({ rooms: [...arena.rooms.values()].map((r) => r.summary()) }));
  app.post('/api/v1/rooms', async (req, reply) => {
    auth(req);
    const b = body(req);
    const room = arena.createRoom(b.name, b.config, b.game);
    reply.status(201);
    return room.summary();
  });
  app.post('/api/v1/rooms/quick-join', async (req) => {
    const bot = auth(req);
    const { room, seat } = arena.quickJoin(bot, body(req).game);
    return { room: room.summary(), seat };
  });
  app.get<P>('/api/v1/rooms/:rid', async (req) => {
    const room = arena.room(req.params.rid);
    return { room: room.summary(), game: room.publicGame(), seq: room.seq };
  });
  app.post<P>('/api/v1/rooms/:rid/join', async (req) => {
    const bot = auth(req);
    const room = arena.room(req.params.rid);
    const seat = body(req).seat;
    if (seat !== undefined && seat !== null && typeof seat !== 'number') throw badRequest('seat must be a number');
    const s = arena.join(bot, room, seat as number | undefined);
    return { room: room.summary(), seat: s };
  });
  app.post<P>('/api/v1/rooms/:rid/leave', async (req) => {
    arena.leave(auth(req), arena.room(req.params.rid));
    return { ok: true };
  });
  app.post<P>('/api/v1/rooms/:rid/ready', async (req) => {
    const bot = auth(req);
    const room = arena.room(req.params.rid);
    const ready = body(req).ready ?? true;
    if (typeof ready !== 'boolean') throw badRequest('ready must be a boolean');
    room.setReady(bot.id, ready);
    return { room: room.summary() };
  });

  // ---------- games ----------
  const liveRoomFor = (gid: string) => {
    const room = arena.liveGameRoom(gid);
    if (room) return room;
    arena.publicGame(gid); // throws 404 if unknown
    throw new ApiError(409, 'WRONG_PHASE', 'game is finished');
  };
  const doAct = (bot: BotRow, gid: string, op: string, b: Record<string, unknown>) => liveRoomFor(gid).act(bot.id, op, b);

  app.get<P>('/api/v1/games/:gid/state', async (req) => {
    const bot = auth(req);
    const gid = req.params.gid;
    const room = arena.liveGameRoom(gid);
    if (!room) {
      arena.publicGame(gid);
      throw new ApiError(409, 'WRONG_PHASE', 'game is finished; use /replay');
    }
    const seat = room.gameSeatOf(bot.id);
    if (seat < 0) throw new ApiError(403, 'NOT_A_PLAYER', 'you are not a player in this game');
    return room.playerGame(seat);
  });
  app.get<P>('/api/v1/games/:gid/legal-moves', async (req) => {
    const bot = auth(req);
    return liveRoomFor(req.params.gid).legalMoves(bot.id);
  });
  for (const op of ['bid', 'play', 'action']) {
    app.post<P>(`/api/v1/games/:gid/${op}`, async (req) => doAct(auth(req), req.params.gid, op, body(req)));
  }
  app.get<P>('/api/v1/games/:gid', async (req) => arena.publicGame(req.params.gid));
  app.get<P>('/api/v1/games/:gid/replay', async (req) => arena.replay(req.params.gid));
  app.get<{ Querystring: { limit?: string; bot_id?: string; game?: string } }>('/api/v1/games', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const game = req.query.game === undefined ? undefined : variantOf(req.query.game).type;
    return { games: arena.recentGames(limit, req.query.bot_id, game) };
  });
  app.get<{ Querystring: { game?: string } }>('/api/v1/leaderboard', async (req) => ({
    game: variantOf(req.query.game).type,
    bots: arena.db.leaderboard(variantOf(req.query.game).type),
  }));
  app.get('/api/v1/docs', async (_req, reply) => {
    if (!opts.docsPath || !existsSync(opts.docsPath)) throw new ApiError(404, 'NOT_FOUND', 'docs not found');
    reply.type('text/markdown; charset=utf-8');
    return readFileSync(opts.docsPath, 'utf8');
  });
  app.get('/api/v1/openapi.yaml', async (_req, reply) => {
    const path = opts.docsPath && join(dirname(opts.docsPath), 'openapi.yaml');
    if (!path || !existsSync(path)) throw new ApiError(404, 'NOT_FOUND', 'openapi spec not found');
    reply.type('application/yaml; charset=utf-8');
    return readFileSync(path, 'utf8');
  });
  app.get('/api/v1/examples/node-bot.mjs', async (_req, reply) => {
    const path = opts.docsPath && join(dirname(opts.docsPath), '../examples/node/bot.mjs');
    if (!path || !existsSync(path)) throw new ApiError(404, 'NOT_FOUND', 'example not found');
    reply.type('text/javascript; charset=utf-8');
    return readFileSync(path, 'utf8');
  });
  app.get('/healthz', async () => ({ ok: true, rooms: arena.rooms.size }));

  // ---------- websockets ----------
  const keepAlive = (ws: WebSocket) => {
    let alive = true;
    ws.on('pong', () => (alive = true));
    const t = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on('close', () => clearInterval(t));
  };
  const sinceOf = (q: Record<string, string | undefined>) => (q.since === undefined ? null : Number(q.since));
  const sendJson = (ws: WebSocket, msg: unknown) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  app.get<{ Querystring: { token?: string; since?: string } }>('/ws', { websocket: true }, (ws, req) => {
    let bot: BotRow;
    try {
      bot = arena.authenticate(req.query.token);
    } catch (e) {
      sendJson(ws, { type: 'error', data: errorBody(e as ApiError).error });
      ws.close(4401, 'unauthorized');
      return;
    }
    keepAlive(ws);
    const room = arena.roomOfBot(bot.id);
    sendJson(ws, { type: 'hello', seq: null, ts: Date.now(), room_id: room?.id ?? null, game_id: room?.gameId ?? null, data: { bot_id: bot.id, room_id: room?.id ?? null, seq: room?.seq ?? 0 } });
    const since = sinceOf(req.query);
    if (room && since !== null && Number.isFinite(since)) {
      const gameSeat = room.gameSeatOf(bot.id);
      const backlog = arena.backlog(room, since, gameSeat >= 0 ? gameSeat : null);
      if (backlog === null) sendJson(ws, { type: 'resync', room_id: room.id, game_id: room.gameId });
      else for (const m of backlog) ws.send(m);
    }
    arena.addPlayerSocket(bot.id, ws);
    ws.on('close', () => arena.removePlayerSocket(bot.id, ws));
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendJson(ws, { type: 'error', data: { code: 'BAD_REQUEST', message: 'invalid JSON' } });
      }
      if (msg.op === 'ping') return sendJson(ws, { type: 'pong', ts: Date.now() });
      if (msg.op !== 'bid' && msg.op !== 'play' && msg.op !== 'action') return sendJson(ws, { type: 'reply', req_id: msg.req_id ?? null, status: 400, body: { error: { code: 'BAD_REQUEST', message: 'op must be ping, bid, play or action' } } });
      let status = 200;
      let result: unknown;
      try {
        if (!limiter.take(bot.id)) throw new ApiError(429, 'RATE_LIMITED', 'too many requests');
        if (typeof msg.game_id !== 'string') throw badRequest('game_id is required');
        result = doAct(bot, msg.game_id, msg.op, msg);
      } catch (e) {
        if (e instanceof ApiError || e instanceof GameError) {
          status = e.status;
          result = errorBody(e);
        } else {
          app.log.error(e);
          status = 500;
          result = { error: { code: 'INTERNAL', message: 'internal server error' } };
        }
      }
      sendJson(ws, { type: 'reply', req_id: msg.req_id ?? null, status, body: result });
    });
  });

  app.get<{ Querystring: { room?: string; since?: string } }>('/ws/spectate', { websocket: true }, (ws, req) => {
    const room = req.query.room ? arena.rooms.get(req.query.room) : undefined;
    if (!room) {
      sendJson(ws, { type: 'error', data: { code: 'NOT_FOUND', message: 'room not found' } });
      ws.close(4404, 'room not found');
      return;
    }
    keepAlive(ws);
    sendJson(ws, { type: 'hello', seq: null, ts: Date.now(), room_id: room.id, game_id: room.gameId, data: { room_id: room.id, seq: room.seq } });
    const since = sinceOf(req.query);
    if (since !== null && Number.isFinite(since)) {
      const backlog = arena.backlog(room, since, null);
      if (backlog === null) sendJson(ws, { type: 'resync', room_id: room.id, game_id: room.gameId });
      else for (const m of backlog) ws.send(m);
    }
    arena.addSpectator(room, ws);
    ws.on('close', () => arena.removeSpectator(room.id, ws));
    ws.on('message', (raw) => {
      if (raw.toString().includes('"ping"')) sendJson(ws, { type: 'pong', ts: Date.now() });
    });
  });

  return { app, arena };
}
