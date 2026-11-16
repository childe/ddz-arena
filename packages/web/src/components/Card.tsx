import type { CSSProperties } from 'react';
import { PATTERN_NAMES, PATTERN_NAMES4 } from '@ddz/engine';
import type { ApiPattern, Card as CardCode, GameType } from '../api.ts';

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };

export function rankLabel(code: CardCode): string {
  if (code === 'BJ' || code === 'RJ') return 'JOKER';
  return code[0] === 'T' ? '10' : code[0]!;
}

export function isRed(code: CardCode): boolean {
  return code === 'RJ' || code[1] === 'H' || code[1] === 'D';
}

export function patternName(p: ApiPattern | null | undefined, game?: GameType): string {
  if (!p) return '';
  const names = (game === 'ddz4' ? PATTERN_NAMES4 : PATTERN_NAMES) as Record<string, string>;
  const name = names[p.type] ?? p.type;
  // ddz4 bombs have 4–8 cards; say how many.
  return game === 'ddz4' && p.type === 'bomb' && p.length > 4 ? `${p.length} 张${name}` : name;
}

/**
 * Stable, unique key per card in a list: the code plus its occurrence index (`3S#0`, `3S#1`).
 * ddz4 hands hold two copies of a card, so the code alone is not unique.
 */
export function cardKeys(cards: CardCode[]): string[] {
  const seen = new Map<CardCode, number>();
  return cards.map((c) => {
    const k = seen.get(c) ?? 0;
    seen.set(c, k + 1);
    return `${c}#${k}`;
  });
}

/** Cards of `hand` whose occurrence key is in `keys` (hand order). */
export function cardsByKeys(hand: CardCode[], keys: Set<string>): CardCode[] {
  const ks = cardKeys(hand);
  return hand.filter((_, i) => keys.has(ks[i]!));
}

/** Occurrence keys in `hand` for a multiset of cards (e.g. a hint move). */
export function keysForCards(hand: CardCode[], cards: CardCode[]): Set<string> {
  const want = new Map<CardCode, number>();
  for (const c of cards) want.set(c, (want.get(c) ?? 0) + 1);
  const ks = cardKeys(hand);
  const out = new Set<string>();
  hand.forEach((c, i) => {
    const n = want.get(c) ?? 0;
    if (n > 0) {
      out.add(ks[i]!);
      want.set(c, n - 1);
    }
  });
  return out;
}

export type CardSize = 'lg' | 'md' | 'sm' | 'xs';

interface CardProps {
  code?: CardCode;
  back?: boolean;
  size?: CardSize;
  selected?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
  className?: string;
}

export function PlayingCard({ code, back, size = 'md', selected, onClick, style, className = '' }: CardProps) {
  const cls = `card card-${size}${selected ? ' selected' : ''}${onClick ? ' clickable' : ''} ${className}`;
  if (back || !code) {
    return (
      <div className={`${cls} card-back`} style={style} aria-label="牌背" onClick={onClick}>
        <div className="card-back-inner" />
      </div>
    );
  }
  const joker = code === 'BJ' || code === 'RJ';
  const red = isRed(code);
  const suit = SUIT_SYMBOL[code[1]!] ?? '';
  return (
    <div
      className={`${cls}${red ? ' red' : ' black'}${joker ? ' joker' : ''}`}
      style={style}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-label={joker ? (code === 'RJ' ? '大王' : '小王') : `${suit}${rankLabel(code)}`}
      aria-pressed={onClick ? !!selected : undefined}
    >
      {joker ? (
        <>
          <div className="card-corner joker-text">JOKER</div>
          <div className="card-center joker-star">★</div>
        </>
      ) : (
        <>
          <div className="card-corner">
            <span className={`card-rank${code[0] === 'T' ? ' r10' : ''}`}>{rankLabel(code)}</span>
            <span className="card-suit">{suit}</span>
          </div>
          <div className="card-center">{suit}</div>
        </>
      )}
    </div>
  );
}

interface HandProps {
  cards?: CardCode[];
  /** Number of backs to draw when cards are hidden. */
  backs?: number;
  size?: CardSize;
  /** Selected occurrence keys (see cardKeys). */
  selected?: Set<string>;
  /** Called with the occurrence key of the clicked card. */
  onToggle?: (key: string) => void;
  /** Split into this many rows (for narrow side seats). */
  rows?: number;
  /** Max visible fraction of each card (0..1) when there is room. */
  spread?: number;
  className?: string;
  animate?: boolean;
}

/** Overlapping fan that always fits its container width (pure CSS). */
export function Hand({ cards, backs = 0, size = 'md', selected, onToggle, rows = 1, spread = 0.55, className = '', animate }: HandProps) {
  const items: (CardCode | null)[] = cards ? cards : new Array<null>(backs).fill(null);
  const keys = cards ? cardKeys(cards) : items.map((_, i) => `b${i}`);
  if (items.length === 0) return <div className={`hand hand-${size} hand-empty ${className}`} />;
  const perRow = Math.ceil(items.length / rows);
  const chunks: (CardCode | null)[][] = [];
  for (let i = 0; i < items.length; i += perRow) chunks.push(items.slice(i, i + perRow));
  return (
    <div className={`hand-rows ${className}`}>
      {chunks.map((chunk, ri) => (
        <div
          key={ri}
          className={`hand hand-${size}${animate ? ' hand-anim' : ''}`}
          style={{ '--n1': Math.max(1, perRow - 1), '--spread': spread } as CSSProperties}
        >
          {chunk.map((c, i) => {
            const k = keys[ri * perRow + i]!;
            return (
              <PlayingCard
                key={k}
                code={c ?? undefined}
                back={c === null}
                size={size}
                selected={c !== null && !!selected?.has(k)}
                onClick={c !== null && onToggle ? () => onToggle(k) : undefined}
                style={animate ? { animationDelay: `${i * 25}ms` } : undefined}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
