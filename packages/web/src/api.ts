// Fetch helpers and types matching docs/api.md.

export type Card = string;
export type Phase = 'bidding' | 'playing' | 'finished';
export type GameType = 'ddz' | 'ddz4' | 'holdem' | 'guandan' | 'gongzhu';

export const GAME_TYPES: GameType[] = ['ddz', 'ddz4', 'holdem', 'guandan', 'gongzhu'];
export const GAME_LABELS: Record<GameType, string> = {
  ddz: '三人斗地主',
  ddz4: '四人斗地主',
  holdem: '德州扑克',
  guandan: '掼蛋',
  gongzhu: '拱猪',
};

/** Normalizes an unknown `game` field (missing = ddz, the server default). */
export function gameTypeOf(v: unknown): GameType {
  return v === 'ddz4' || v === 'holdem' || v === 'guandan' || v === 'gongzhu' ? v : 'ddz';
}

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
  /** Hold'em only. */
  action_timeout_ms: number;
  /** Hold'em only: number of seats (2–6). */
  seats: number;
  legal_moves_api: boolean;
  auto_restart: boolean;
}

export interface Room {
  id: string;
  name: string;
  /** Missing on old servers: treat as ddz. */
  game?: GameType;
  status: 'waiting' | 'playing' | string;
  seats: (SeatInfo | null)[];
  spectators: number;
  game_id: string | null;
  games_played: number;
  config?: Partial<RoomConfig>;
  /** Bot that created the room and may dissolve it (null: made by quick-join). */
  owner_id?: string | null;
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
  game?: GameType;
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

// ---- Hold'em (docs/api.md section 9) ----

export type HoldemPhase = 'preflop' | 'flop' | 'turn' | 'river' | 'finished';
export type HoldemAction = 'fold' | 'check' | 'call' | 'raise';

export interface HoldemActionRecord {
  seat: number;
  phase: Exclude<HoldemPhase, 'finished'>;
  action: HoldemAction | 'small_blind' | 'big_blind';
  /** raise: raise-to total for the street; call / blinds: chips added; fold / check: 0. */
  amount: number;
  all_in: boolean;
}

export interface HoldemShowdownEntry {
  seat: number;
  hole: Card[];
  best: Card[];
  rank: string;
  score: number;
}

export interface HoldemResult {
  winners: number[];
  scores: (number | null)[];
  payouts: (number | null)[];
  showdown: HoldemShowdownEntry[] | null;
  pot: number;
}

/** Fields of the `turn` event (and PlayerGame.legal). */
export interface HoldemLegal {
  phase?: HoldemPhase;
  to_call: number;
  can_check: boolean;
  min_raise_to: number | null;
  max_raise_to: number | null;
  current_bet: number;
  pot: number;
}

export interface HoldemPublicGame {
  game_id: string;
  room_id: string;
  game: 'holdem';
  phase: HoldemPhase;
  players: Player[];
  turn: number | null;
  deadline: number | null;
  remaining_ms: number | null;
  button: number;
  small_blind_seat: number;
  big_blind_seat: number;
  small_blind: number;
  big_blind: number;
  board: Card[];
  pot: number;
  current_bet: number;
  min_raise_to: number | null;
  stacks: (number | null)[];
  bets: (number | null)[];
  committed: (number | null)[];
  folded: (boolean | null)[];
  all_in: (boolean | null)[];
  history: HoldemActionRecord[];
  result: HoldemResult | null;
  seq: number;
  turn_seq: number;
}

export interface HoldemPlayerGame extends HoldemPublicGame {
  seat: number;
  hole: Card[];
  legal?: HoldemLegal;
}

export interface HoldemReplay extends HoldemPublicGame {
  seed: string;
  holes: (Card[] | null)[];
  events: WsEvent[];
}

// ---- Guandan (docs/guandan.md section 5) ----

export type GdPhase = 'return' | 'playing' | 'finished';

/** One tribute (进贡) or return (还贡): `from` gives `card` to `to`. */
export interface GdTransfer {
  from: number;
  to: number;
  card: Card;
  auto?: boolean;
}

export interface GdTributeInfo {
  /** True when the tribute was refused with two big jokers (抗贡). */
  anti: boolean;
  tributes: GdTransfer[];
}

export interface GdResult {
  /** Finishing order, first finisher (头游) first. */
  order: number[];
  winner_team: 0 | 1;
  /** Levels gained by the winning team (1–3). */
  upgrade: number;
  /** Level played this hand. */
  level: string;
  team_levels_before: [string, string];
  team_levels_after: [string, string];
  level_team_next: 0 | 1;
  a_attempts: [number, number];
  match_winner: 0 | 1 | null;
  scores: number[];
}

export interface GuandanPublicGame {
  game_id: string;
  room_id: string;
  game: 'guandan';
  phase: GdPhase;
  players: Player[];
  hand_no: number;
  level: string;
  level_team: 0 | 1;
  team_levels: [string, string];
  a_attempts: [number, number];
  tribute: GdTributeInfo | null;
  returns: GdTransfer[];
  turn: number | null;
  deadline: number | null;
  remaining_ms: number | null;
  to_beat: PlayRecord | null;
  can_pass: boolean;
  cards_left: number[];
  /** Seats that are out, first finisher first (all four once finished). */
  order: number[];
  history: PlayRecord[];
  result: GdResult | null;
  seq: number;
  turn_seq: number;
}

export interface GuandanPlayerGame extends GuandanPublicGame {
  seat: number;
  hand: Card[];
  legal?: { phase: 'return' | 'playing'; return_cards?: Card[]; to_beat?: PlayRecord | null; can_pass?: boolean };
}

export interface GuandanReplay extends GuandanPublicGame {
  seed: string;
  /** Hands after the deal, before any tribute. */
  initial_hands: Card[][];
  events: WsEvent[];
}

// ---- Gongzhu (docs/gongzhu.md section 5) ----

export type GzPhase = 'expose' | 'playing' | 'finished';

export interface GzPlayRecord {
  seat: number;
  card: Card;
  /** Played by the server on timeout (events only). */
  auto?: boolean;
}

export interface GzTrickRecord {
  leader: number;
  plays: GzPlayRecord[];
  /** Set once all four have played. */
  winner: number | null;
}

export interface GzResult {
  /** Points of this hand per seat. */
  points: number[];
  totals_before: number[];
  totals_after: number[];
  /** Scoring cards each seat took. */
  taken: Card[][];
  exposed: Card[][];
  /** Seat that took all 13 hearts (全红), if any. */
  all_hearts: number | null;
  /** Seat that took the pig; it leads the next hand. */
  pig: number | null;
  /** Seats whose total reached -1000; the match is over when non-empty. */
  losers: number[];
  match_over: boolean;
  scores: number[];
}

export interface GongzhuPublicGame {
  game_id: string;
  room_id: string;
  game: 'gongzhu';
  phase: GzPhase;
  players: Player[];
  hand_no: number;
  /** Cumulative points before this hand. */
  totals: number[];
  first_leader: number;
  exposed: Card[][];
  turn: number | null;
  deadline: number | null;
  remaining_ms: number | null;
  trick_no: number;
  led_suit: string | null;
  /** Trick in progress, null between tricks. */
  trick: GzTrickRecord | null;
  /** Completed tricks. */
  tricks: GzTrickRecord[];
  taken: Card[][];
  cards_left: number[];
  result: GzResult | null;
  seq: number;
  turn_seq: number;
}

export interface GongzhuPlayerGame extends GongzhuPublicGame {
  seat: number;
  hand: Card[];
  legal?: { phase: 'expose'; exposable: Card[] } | { phase: 'playing'; cards: Card[] };
}

export interface GongzhuReplay extends GongzhuPublicGame {
  seed: string;
  initial_hands: Card[][];
  events: WsEvent[];
}

export type AnyPublicGame = PublicGame | HoldemPublicGame | GuandanPublicGame | GongzhuPublicGame;
export type AnyReplay = Replay | HoldemReplay | GuandanReplay | GongzhuReplay;

export function isGuandanGame(g: object | null | undefined): boolean {
  return !!g && (g as { game?: unknown }).game === 'guandan';
}

export function isGongzhuGame(g: object | null | undefined): boolean {
  return !!g && (g as { game?: unknown }).game === 'gongzhu';
}

export function isHoldemGame(g: object | null | undefined): boolean {
  if (!g) return false;
  const x = g as { game?: unknown; button?: unknown };
  return x.game === 'holdem' || (x.game === undefined && x.button !== undefined);
}

/**
 * docs/api.md does not define GameSummary; every field except game_id is treated as optional.
 */
export interface GameSummary {
  game_id: string;
  room_id?: string;
  game?: GameType;
  players?: Player[];
  landlord?: number | null;
  /** GameResult for ddz / ddz4, HoldemResult for holdem, GdResult for guandan, GzResult for gongzhu. */
  result?: GameResult | HoldemResult | GdResult | GzResult | null;
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
  NO_FREE_BOT: '智能 bot 都在忙（每种游戏最多 4 个同时在打），稍后再试',
  BOT_SERVICE_DOWN: '智能 bot 服务没有运行',
  NOT_SEATED: '先入座才能邀请智能 bot',
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
  LEGAL_MOVES_DISABLED: '房间关闭了合法出牌接口',
  BAD_ACTION: '当前不能这样操作',
  CANNOT_CHECK: '面对下注不能过牌',
  BAD_AMOUNT: '加注额不合法',
  PATTERN_MISMATCH: '这些牌不能按所选牌型出',
  BAD_RETURN: '只能还 2–10 的牌（不能还王和逢人配）',
  MUST_FOLLOW_SUIT: '有领出的花色就必须跟这门花色',
  EXPOSED_CARD_LOCKED: '亮出的牌在这门花色第一轮不能出',
  BAD_EXPOSE: '只能亮手里的 ♠Q / ♦J / ♣10 / ♥A',
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
  room: (rid: string) => request<{ room: Room; game: AnyPublicGame | null }>('GET', `/rooms/${encodeURIComponent(rid)}`),
  createRoom: (token: string, opts: { name?: string; game?: GameType; config?: Partial<RoomConfig> } = {}) =>
    request<Room>('POST', '/rooms', {
      token,
      body: {
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.game ? { game: opts.game } : {}),
        ...(opts.config && Object.keys(opts.config).length ? { config: opts.config } : {}),
      },
    }),
  join: (token: string, rid: string, seat?: number) =>
    request<{ room: Room; seat: number }>('POST', `/rooms/${encodeURIComponent(rid)}/join`, {
      token,
      body: seat === undefined ? {} : { seat },
    }),
  /** Ask the smart-bot service to fill up to `count` empty seats (default: all). */
  inviteSmartBots: (token: string, rid: string, count?: number) =>
    request<{ invited: number }>('POST', `/rooms/${encodeURIComponent(rid)}/smart-bots`, { token, body: count ? { count } : {} }),
  /** Creator only: close the room now; a running game is dropped. */
  dissolve: (token: string, rid: string) => request<{ ok: true }>('DELETE', `/rooms/${encodeURIComponent(rid)}`, { token }),
  leave: (token: string, rid: string) => request<{ ok: true }>('POST', `/rooms/${encodeURIComponent(rid)}/leave`, { token, body: {} }),
  ready: (token: string, rid: string, ready = true) =>
    request<{ room: Room }>('POST', `/rooms/${encodeURIComponent(rid)}/ready`, { token, body: { ready } }),

  game: (gid: string) => request<PublicGame>('GET', `/games/${encodeURIComponent(gid)}`),
  gameState: (token: string, gid: string) => request<PlayerGame | HoldemPlayerGame | GuandanPlayerGame | GongzhuPlayerGame>('GET', `/games/${encodeURIComponent(gid)}/state`, { token }),
  bid: (token: string, gid: string, score: number, seq?: number) =>
    request<{ ok: true; seq: number }>('POST', `/games/${encodeURIComponent(gid)}/bid`, { token, body: { score, seq } }),
  /** `pattern` (guandan only) picks one interpretation when the cards can be read several ways. */
  play: (token: string, gid: string, cards: Card[], seq?: number, pattern?: { type: string; rank?: string }) =>
    request<{ ok: true; seq: number; pattern: ApiPattern | null }>('POST', `/games/${encodeURIComponent(gid)}/play`, {
      token,
      body: { cards, seq, ...(pattern ? { pattern } : {}) },
    }),
  /** Gongzhu: expose some of QS / JD / TC / AH (`[]` = 不亮). */
  expose: (token: string, gid: string, cards: Card[], seq?: number) =>
    request<{ ok: true; seq: number }>('POST', `/games/${encodeURIComponent(gid)}/expose`, { token, body: { cards, seq } }),
  /** Gongzhu: play one card. */
  playCard: (token: string, gid: string, card: Card, seq?: number) =>
    request<{ ok: true; seq: number }>('POST', `/games/${encodeURIComponent(gid)}/play`, { token, body: { card, seq } }),
  /** Guandan: give one card back to the tribute payer (还贡). */
  returnCard: (token: string, gid: string, card: Card, seq?: number) =>
    request<{ ok: true; seq: number }>('POST', `/games/${encodeURIComponent(gid)}/return`, { token, body: { card, seq } }),
  action: (token: string, gid: string, action: HoldemAction, amount?: number, seq?: number) =>
    request<{ ok: true; seq: number }>('POST', `/games/${encodeURIComponent(gid)}/action`, {
      token,
      body: { action, ...(action === 'raise' ? { amount } : {}), seq },
    }),
  replay: (gid: string) => request<AnyReplay>('GET', `/games/${encodeURIComponent(gid)}/replay`),
  games: (limit = 20, filter: { botId?: string; game?: GameType; roomId?: string } = {}) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (filter.botId) q.set('bot_id', filter.botId);
    if (filter.game) q.set('game', filter.game);
    if (filter.roomId) q.set('room_id', filter.roomId);
    return request<{ games: GameSummary[] }>('GET', `/games?${q}`);
  },
  leaderboard: (game: GameType = 'ddz') =>
    request<{ game?: GameType; bots: LeaderboardRow[] }>('GET', `/leaderboard?game=${game}`),

  docs: async (): Promise<string> => {
    const res = await fetch(`${BASE}/docs`, { headers: { accept: 'text/markdown, text/plain, */*' } });
    if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, res.statusText);
    return res.text();
  },
};

// ---- guest identity (localStorage, guarded) ----

const GUEST_KEY = 'ddz.guest';
/** Identities used in this browser, most recent first; kept after 退出 so they can be switched back to. */
const KNOWN_KEY = 'ddz.guests';

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
    if (g) {
      localStorage.setItem(GUEST_KEY, JSON.stringify(g));
      saveKnown([g, ...loadKnown().filter((k) => k.bot_id !== g.bot_id)]);
    } else {
      saveKnown(loadKnown()); // keep the identity being signed out of (it may predate the list)
      localStorage.removeItem(GUEST_KEY);
    }
  } catch {
    /* storage unavailable: identity lives only for this page load */
  }
}

export function loadKnown(): Account[] {
  try {
    const list = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '[]');
    const known = Array.isArray(list) ? (list.filter((g) => g && typeof g.token === 'string') as Account[]) : [];
    // Identities saved before this list existed.
    const cur = loadGuest();
    return cur && !known.some((k) => k.bot_id === cur.bot_id) ? [cur, ...known] : known;
  } catch {
    return [];
  }
}

function saveKnown(list: Account[]): void {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* storage unavailable */
  }
}

/** Remove an identity from this browser for good (its token is lost unless saved elsewhere). */
export function forgetKnown(botId: string): void {
  saveKnown(loadKnown().filter((k) => k.bot_id !== botId));
}
