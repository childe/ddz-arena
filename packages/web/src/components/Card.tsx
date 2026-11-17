import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from 'react';
import { GD_PATTERN_NAMES, PATTERN_NAMES, PATTERN_NAMES4 } from '@ddz/engine';
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
  if (game === 'guandan') {
    const name = (GD_PATTERN_NAMES as Record<string, string>)[p.type] ?? p.type;
    // Guandan bombs have 4–8 cards; always say how many.
    return p.type === 'bomb' ? `${p.length} 张${name}` : name;
  }
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
  /** Guandan wildcard (逢人配): drawn with a gold frame and a 配 tag. */
  wild?: boolean;
  /** Greyed out and not clickable (e.g. cards that cannot be returned). */
  disabled?: boolean;
}

export function PlayingCard({ code, back, size = 'md', selected, onClick, style, className = '', wild, disabled }: CardProps) {
  const cls = `card card-${size}${selected ? ' selected' : ''}${onClick ? ' clickable' : ''}${wild ? ' card-wild' : ''}${disabled ? ' card-disabled' : ''} ${className}`;
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
      aria-label={joker ? (code === 'RJ' ? '大王' : '小王') : `${suit}${rankLabel(code)}${wild ? '（逢人配）' : ''}`}
      aria-disabled={disabled || undefined}
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
          {wild && <div className="wild-tag">配</div>}
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
  /** Guandan wildcard code (e.g. "7H"); copies of it are marked. */
  wild?: CardCode;
  /** Cards for which this returns false are greyed out and not clickable. */
  enabled?: (code: CardCode) => boolean;
}

/** True below 640px, where long own hands are split into two rows. */
export function useNarrow(): boolean {
  const q = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * Index of the card under (x, y) in a fan: the row nearest to y, then the last card whose
 * left edge is at or before x (later cards cover earlier ones). Only x decides within a row,
 * so a raised (selected) card is still hit at its old spot. -1 when left of every card.
 */
function cardAt(rowsEl: HTMLElement, x: number, y: number): number {
  const rows = Array.from(rowsEl.children) as HTMLElement[];
  let best = -1;
  let bestDist = Infinity;
  rows.forEach((row, i) => {
    const r = row.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  let offset = 0;
  for (let i = 0; i < best; i++) offset += rows[i]!.children.length;
  const cards = Array.from(rows[best]?.children ?? []) as HTMLElement[];
  for (let i = cards.length - 1; i >= 0; i--) {
    const r = cards[i]!.getBoundingClientRect();
    if (x >= r.left) return i === cards.length - 1 && x > r.right ? -1 : offset + i;
  }
  return -1;
}

/**
 * Overlapping fan that always fits its container width (pure CSS). With ``onToggle`` the
 * cards are picked by pointer: a tap toggles one card, a press-and-slide toggles every card
 * it passes over (sliding back untoggles them again).
 */
export function Hand({ cards, backs = 0, size = 'md', selected, onToggle, rows = 1, spread = 0.55, className = '', animate, wild, enabled }: HandProps) {
  const drag = useRef<{ start: number; toggled: Set<number> } | null>(null);
  const items: (CardCode | null)[] = cards ? cards : new Array<null>(backs).fill(null);
  const keys = cards ? cardKeys(cards) : items.map((_, i) => `b${i}`);
  if (items.length === 0) return <div className={`hand hand-${size} hand-empty ${className}`} />;
  const perRow = Math.ceil(items.length / rows);
  const chunks: (CardCode | null)[][] = [];
  for (let i = 0; i < items.length; i += perRow) chunks.push(items.slice(i, i + perRow));
  const pickable = (i: number) => items[i] != null && (!enabled || enabled(items[i]!));
  const pick = !!(cards && onToggle);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    const i = cardAt(e.currentTarget, e.clientX, e.clientY);
    if (i < 0 || !pickable(i)) return;
    drag.current = { start: i, toggled: new Set([i]) };
    onToggle!(keys[i]!);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const i = cardAt(e.currentTarget, e.clientX, e.clientY);
    if (i < 0) return;
    const lo = Math.min(d.start, i);
    const hi = Math.max(d.start, i);
    for (const j of [...d.toggled]) {
      if (j < lo || j > hi) {
        d.toggled.delete(j);
        onToggle!(keys[j]!);
      }
    }
    for (let j = lo; j <= hi; j++) {
      if (!d.toggled.has(j) && pickable(j)) {
        d.toggled.add(j);
        onToggle!(keys[j]!);
      }
    }
  };
  const onPointerEnd = () => {
    drag.current = null;
  };

  return (
    <div
      className={`hand-rows${pick ? ' hand-pick' : ''} ${className}`}
      onPointerDown={pick ? onPointerDown : undefined}
      onPointerMove={pick ? onPointerMove : undefined}
      onPointerUp={pick ? onPointerEnd : undefined}
      onPointerCancel={pick ? onPointerEnd : undefined}
    >
      {chunks.map((chunk, ri) => (
        <div
          key={ri}
          className={`hand hand-${size}${animate ? ' hand-anim' : ''}`}
          style={{ '--n1': Math.max(1, perRow - 1), '--spread': spread } as CSSProperties}
        >
          {chunk.map((c, i) => {
            const k = keys[ri * perRow + i]!;
            const off = c !== null && enabled ? !enabled(c) : false;
            return (
              <PlayingCard
                key={k}
                code={c ?? undefined}
                back={c === null}
                size={size}
                selected={c !== null && !!selected?.has(k)}
                className={pick && !off ? 'clickable' : ''}
                wild={c !== null && c === wild}
                disabled={off}
                style={animate ? { animationDelay: `${i * 25}ms` } : undefined}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
