// A game type plugs into the generic Room through these interfaces. The Room owns seating, readiness,
// turn timers, trustee mode, the event buffer and persistence; a GameSession owns the rules of one deal.

export type GameType = 'ddz' | 'ddz4' | 'holdem' | 'guandan' | 'gongzhu';

/** An event the session wants emitted. `priv` is merged into `data` only for the player in that seat. */
export interface Emit {
  type: string;
  data: Record<string, unknown>;
  priv?: Record<number, Record<string, unknown>>;
}

export interface ActResult {
  events: Emit[];
  /** Extra fields for the HTTP/WS reply besides `ok` and `seq` (seq = the first emitted event). */
  reply?: Record<string, unknown>;
}

/** One row per participant, stored in game_players. */
export interface PlayerOutcome {
  seat: number;
  score: number;
  win: boolean;
  isLandlord: boolean;
}

export interface GameSession {
  readonly seed: string;
  /** Participating seats, ascending. */
  readonly seats: number[];
  readonly finished: boolean;
  /** Seat to act, or null when finished. */
  readonly turn: number | null;
  /** Events for the start of the deal (usually one `game.started` with private hands). */
  startEvents(): Emit[];
  /** Event announcing whose turn it is (the Room adds deadline and remaining_ms). */
  turnEvent(): Emit;
  /** Normal time limit for the current turn. */
  turnTimeout(config: Record<string, unknown>): number;
  /** Apply a player action. `op` is the API verb (bid / play / action). Throws GameError or ApiError. */
  act(seat: number, op: string, body: Record<string, unknown>): ActResult;
  /** The action taken on timeout. */
  auto(seat: number): Emit[];
  /** Game-specific public fields of GET /games/{gid}. */
  publicView(): Record<string, unknown>;
  /** Extra fields for the player in `seat` (hand, hole cards...). */
  privateView(seat: number): Record<string, unknown>;
  legalMoves(seat: number): Record<string, unknown>;
  /** True when the deal ended without a result and should be redealt (e.g. nobody bid). */
  readonly redeal: boolean;
  /** Data of the `game.finished` event (the Room adds nothing). */
  finishedData(): Record<string, unknown>;
  /** Serialized result stored with the game and shown in summaries. */
  resultData(): Record<string, unknown>;
  outcomes(): PlayerOutcome[];
  /** Hidden information revealed in the replay (seed, initial hands...). */
  replayData(): Record<string, unknown>;
}

export interface GameVariant {
  type: GameType;
  /** Number of seats in a room with this config. */
  seatCount(config: Record<string, unknown>): number;
  /** Minimum ready players to start; equal to seatCount when every seat must be filled. */
  minPlayers(config: Record<string, unknown>): number;
  defaultConfig: Record<string, unknown>;
  /** Validates and normalizes a room config (throws ApiError 400). */
  parseConfig(raw: Record<string, unknown>): Record<string, unknown>;
  /** How many times a deal may be redealt in a row before it is recorded as is. */
  maxRedeals: number;
  /** Start a deal. `prev` is the previous session in the room, if any (used e.g. to move the button). */
  create(seed: string, seats: number[], config: Record<string, unknown>, prev: GameSession | null): GameSession;
}
