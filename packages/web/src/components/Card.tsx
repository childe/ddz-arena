import type { CSSProperties } from 'react';
import { PATTERN_NAMES } from '@ddz/engine';
import type { ApiPattern, Card as CardCode } from '../api.ts';

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };

export function rankLabel(code: CardCode): string {
  if (code === 'BJ' || code === 'RJ') return 'JOKER';
  return code[0] === 'T' ? '10' : code[0]!;
}

export function isRed(code: CardCode): boolean {
  return code === 'RJ' || code[1] === 'H' || code[1] === 'D';
}

export function patternName(p: ApiPattern | null | undefined): string {
  if (!p) return '';
  return (PATTERN_NAMES as Record<string, string>)[p.type] ?? p.type;
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
  selected?: Set<CardCode>;
  onToggle?: (c: CardCode) => void;
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
          {chunk.map((c, i) => (
            <PlayingCard
              key={c ?? `b${ri}-${i}`}
              code={c ?? undefined}
              back={c === null}
              size={size}
              selected={c !== null && !!selected?.has(c)}
              onClick={c !== null && onToggle ? () => onToggle(c) : undefined}
              style={animate ? { animationDelay: `${i * 25}ms` } : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
