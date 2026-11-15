// Fetch helpers and types matching docs/api.md.

export type Card = string;
export type Phase = 'bidding' | 'playing' | 'finished';

export interface ApiPattern {
  type: string;
  rank: string;
  length: number;
}

export interface SeatInfo {
  seat: number;
  bot_id: string;
  name: string;
  kind: 'bot' | 'human';
  ready: boolean;
  connected: boolean;
  trustee: boolean;
  score: number;
}

export interface RoomConfig {
  bid_timeout_ms: number;
  play_timeout_ms: number;
  legal_moves_api: boolean;
  auto_restart: boolean;
}

export interface Room {
  id: string;
  name: string;
  status: 'waiting' | 'playing' | string;
  seats: (SeatInfo | null)[];
  spectators: number;
  game_id: string | null;
  games_played: number;
  config?: Partial<RoomConfig>;
}

export interface Player {
  seat: number;
  bot_id: string;
  name: string;
  kind?: 'bot' | 'human';
}

export interface PlayRecord {
  seat: number;
  /** Empty for a pass. */
  cards: Card[];
  pattern: ApiPattern | null;
}

export interface GameResult {
  kind: 'win' | 'nobid';
  winner: 'landlord' | 'farmers' | null;
  winner_seat: number | null;
  landlord: number | null;
  base: number;
  bombs: number;
  spring: boolean;
  anti_spring: boolean;
  multiplier: number;
  scores: number[];
}

export interface PublicGame {
  game_id: string;
  room_id: string;
  phase: Phase;
  players: Player[];
  first_bidder: number;
  bids: { seat: number; score: number }[];
  high_bid: number;
  landlord: number | null;
  bottom: Card[] | null;
  turn: number | null;
  deadline: number | null;
  remaining_ms: number | null;
  to_beat: PlayRecord | null;
  can_pass: boolean;
  cards_left: number[];
  multiplier: number;
  history: PlayRecord[];
  result: GameResult | null;
  seq: number;
  turn_seq: number;
}

export interface PlayerGame extends PublicGame {
  seat: number;
  hand: Card[];
}

export interface Replay extends PublicGame {
  seed: string;
  initial_hands: Card[][];
  events: WsEvent[];
}

/**
 * docs/api.md does not define GameSummary; every field except game_id is treated as optional.
 */
export interface GameSummary {
  game_id: string;
  room_id?: string;
  players?: Player[];
  landlord?: number | null;
  result?: GameResult | null;
  phase?: Phase;
  started_at?: number | string;
  finished_at?: number | string;
  ended_at?: number | string;
  created_at?: number | string;
  [k: string]: unknown;
}

export interface LeaderboardRow {
  bot_id: string;
  name: string;
  kind?: 'bot' | 'human';
  games: number;
  wins: number;
  landlord_games: number;
  landlord_wins: number;
  score: number;
  timeouts: number;
}

export interface Me {
  bot_id: string;
  name: string;
  kind: 'bot' | 'human';
  room_id: string | null;
  seat: number | null;
  game_id: string | null;
}

export interface Account {
  bot_id: string;
  name: string;
  kind: 'bot' | 'human';
  token: string;
}

export interface WsEvent {
  type: string;
  seq: number;
  ts: number;
  room_id: string;
  game_id: string | null;
  data: any;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ERROR_TEXT: Record<string, string> = {
  BAD_REQUEST: '请求格式错误',
  UNKNOWN_CARD: '牌编码不存在',
  BAD_BID: '叫分必须是 0–3',
  UNAUTHORIZED: '身份无效，请重新创建游客身份',
  NOT_A_PLAYER: '你不是该局玩家',
  NOT_FOUND: '房间或牌局不存在',
  NAME_TAKEN: '名字已被占用',
  ROOM_FULL: '房间已满',
  SEAT_TAKEN: '座位已有人',
  ALREADY_IN_ROOM: '你已经在别的房间里',
  NOT_IN_ROOM: '你不在这个房间',
  WRONG_PHASE: '当前阶段不能这样操作',
  NOT_YOUR_TURN: '还没轮到你',
  STALE_SEQ: '状态已过期，请重试',
  GAME_IN_PROGRESS: '对局进行中',
  BID_TOO_LOW: '叫分必须高于当前最高分',
  CARDS_NOT_IN_HAND: '所选的牌不在手里',
  MUST_PLAY: '首出不能不出',
  INVALID_PATTERN: '不成牌型',
  CANNOT_BEAT: '压不过上家',
  RATE_LIMITED: '操作太频繁',
};

/** Human-readable Chinese text for an error, keeping the server message for detail. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const zh = ERROR_TEXT[e.code];
    return zh ? `${zh}（${e.message}）` : e.message || e.code;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

const BASE = '/api/v1';

async function request<T>(method: string, path: string, opts: { token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络错误，无法连接服务器');
  }
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = json?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? (text.slice(0, 200) || res.statusText), err?.details);
  }
  return json as T;
}

export const api = {
  createGuest: (name: string) => request<Account>('POST', '/guests', { body: { name } }),
  me: (token: string) => request<Me>('GET', '/me', { token }),

  rooms: () => request<{ rooms: Room[] }>('GET', '/rooms'),
  room: (rid: string) => request<{ room: Room; game: PublicGame | null }>('GET', `/rooms/${encodeURIComponent(rid)}`),
  createRoom: (token: string, name?: string) =>
    request<Room>('POST', '/rooms', { token, body: name ? { name } : {} }),
  join: (token: string, rid: string, seat?: number) =>
    request<{ room: Room; seat: number }>('POST', `/rooms/${encodeURIComponent(rid)}/join`, {
      token,
      body: seat === undefined ? {} : { seat },
    }),
  leave: (token: string, rid: string) => request<{ ok: true }>('POST', `/rooms/${encodeURIComponent(rid)}/leave`, { token, body: {} }),
  ready: (token: string, rid: string, ready = true) =>
    request<{ room: Room }>('POST', `/rooms/${encodeURIComponent(rid)}/ready`, { token, body: { ready } }),

  game: (gid: string) => request<PublicGame>('GET', `/games/${encodeURIComponent(gid)}`),
  gameState: (token: string, gid: string) => request<PlayerGame>('GET', `/games/${encodeURIComponent(gid)}/state`, { token }),
  bid: (token: string, gid: string, score: number, seq?: number) =>
    request<{ ok: true; seq: number }>('POST', `/games/${encodeURIComponent(gid)}/bid`, { token, body: { score, seq } }),
  play: (token: string, gid: string, cards: Card[], seq?: number) =>
    request<{ ok: true; seq: number; pattern: ApiPattern | null }>('POST', `/games/${encodeURIComponent(gid)}/play`, {
      token,
      body: { cards, seq },
    }),
  replay: (gid: string) => request<Replay>('GET', `/games/${encodeURIComponent(gid)}/replay`),
  games: (limit = 20, botId?: string) =>
    request<{ games: GameSummary[] }>(
      'GET',
      `/games?limit=${limit}${botId ? `&bot_id=${encodeURIComponent(botId)}` : ''}`,
    ),
  leaderboard: () => request<{ bots: LeaderboardRow[] }>('GET', '/leaderboard'),

  docs: async (): Promise<string> => {
    const res = await fetch(`${BASE}/docs`, { headers: { accept: 'text/markdown, text/plain, */*' } });
    if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, res.statusText);
    return res.text();
  },
};

// ---- guest identity (localStorage, guarded) ----

const GUEST_KEY = 'ddz.guest';

export function loadGuest(): Account | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw);
    return g && typeof g.token === 'string' ? (g as Account) : null;
  } catch {
    return null;
  }
}

export function saveGuest(g: Account | null): void {
  try {
    if (g) localStorage.setItem(GUEST_KEY, JSON.stringify(g));
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* storage unavailable: identity lives only for this page load */
  }
}
