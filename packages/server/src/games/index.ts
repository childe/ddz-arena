import { badRequest } from '../errors.ts';
import { ddz3, ddz4 } from './ddz.ts';
import { gongzhu } from './gongzhu.ts';
import { guandan } from './guandan.ts';
import { holdem } from './holdem.ts';
import type { GameType, GameVariant } from './types.ts';

export * from './types.ts';

export const VARIANTS: Partial<Record<GameType, GameVariant>> = { ddz: ddz3, ddz4, holdem, guandan, gongzhu };

export function variantOf(game: unknown): GameVariant {
  if (game === undefined || game === null) return ddz3;
  const v = typeof game === 'string' ? VARIANTS[game as GameType] : undefined;
  if (!v) throw badRequest(`game must be one of: ${Object.keys(VARIANTS).join(', ')}`);
  return v;
}
