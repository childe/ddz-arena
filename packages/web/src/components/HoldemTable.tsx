import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Card, HoldemAction, HoldemLegal } from '../api.ts';
import {
  HOLDEM_PHASE_LABELS,
  type HoldemLogEntry,
  type HoldemView,
  holdemActionText,
  holdemRankLabel,
} from '../holdemState.ts';
import { type TableState, seatName } from '../state.ts';
import { PlayingCard } from './Card.tsx';
import { CountdownRing } from './Countdown.tsx';

export interface HoldemTableProps {
  state: TableState;
  /** Seat drawn at the bottom. */
  viewSeat: number;
  /** Show every known hole card face up (replay god view). */
  reveal: boolean;
  showTimers: boolean;
  mySeat?: number | null;
  /** Extra control on a seat (e.g. 入座 for an empty seat). */
  seatExtra?: (seat: number) => ReactNode;
  /** Action bar under the table (own turn controls, ready / leave). */
  controls?: ReactNode;
  resultFooter?: ReactNode;
  idleText?: string;
}

/** Seat count of the hold'em table. */
export function holdemSeats(state: TableState): number {
  return state.holdem?.n ?? state.room?.seats.length ?? 6;
}

export function HoldemTable(props: HoldemTableProps) {
  const { state, viewSeat } = props;
  const h = state.holdem;
  const n = holdemSeats(state);
  // Clockwise from the bottom: the next seat sits to the viewer's left.
  const pos = (seat: number) => {
    const k = (seat - viewSeat + n) % n;
    const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
    return { cos: Math.cos(a), sin: Math.sin(a) };
  };
  return (
    <div className="holdem-wrap">
      <div className={`holdem-table holdem-n${n}`}>
        <div className="holdem-felt" />
        <div className="holdem-center">
          {h ? <Board h={h} /> : <div className="idle-text">{props.idleText ?? '等待开局'}</div>}
        </div>
        {Array.from({ length: n }, (_, seat) => {
          const p = pos(seat);
          const seatStyle = { left: `${50 + 41 * p.cos}%`, top: `${50 + 36 * p.sin}%` } as CSSProperties;
          const betStyle = { left: `${50 + 24 * p.cos}%`, top: `${50 + 20 * p.sin}%` } as CSSProperties;
          const bet = h?.bets[seat] ?? 0;
          return (
            <div key={seat}>
              <div className="h-seat-pos" style={seatStyle}>
                <HoldemSeat {...props} seat={seat} />
              </div>
              {h && bet > 0 && (
                <div className="h-bet" style={betStyle} title="本轮下注">
                  <span className="h-chip-icon" />
                  {bet}
                </div>
              )}
            </div>
          );
        })}
        {h?.phase === 'finished' && h.result && <HoldemResultPanel key={h.game_id} state={state} footer={props.resultFooter} reveal={props.reveal} mySeat={props.mySeat ?? null} />}
      </div>
      {props.controls}
    </div>
  );
}

function Board({ h }: { h: HoldemView }) {
  return (
    <div className="h-board-wrap">
      <div className="chips">
        <span className="chip">{HOLDEM_PHASE_LABELS[h.phase] ?? h.phase}</span>
        <span className="chip">
          盲注 {h.small_blind}/{h.big_blind}
        </span>
      </div>
      <div className="h-board" aria-label="公共牌">
        {Array.from({ length: 5 }, (_, i) =>
          h.board[i] ? (
            <PlayingCard key={`${i}-${h.board[i]}`} code={h.board[i]} size="md" className="h-board-card" />
          ) : (
            <div key={i} className="h-board-slot" />
          ),
        )}
      </div>
      <div className="h-pot">底池 {h.result ? h.result.pot : h.pot}</div>
    </div>
  );
}

function HoldemSeat(props: HoldemTableProps & { seat: number }) {
  const { state, seat, reveal, showTimers, mySeat } = props;
  const h = state.holdem;
  const info = state.room?.seats[seat] ?? null;
  const player = h?.players.find((p) => p.seat === seat);
  const name = info?.name ?? player?.name;
  const isMine = mySeat === seat;
  const inHand = !!h && h.stacks[seat] !== null && h.stacks[seat] !== undefined;
  const folded = !!h?.folded[seat];
  const allIn = !!h?.all_in[seat];
  const onTurn = !!h && h.turn === seat && h.phase !== 'finished';
  const hole = h?.holes[seat] ?? null;
  const shownAtShowdown = !!h?.result?.showdown?.some((e) => e.seat === seat);
  const faceUp = !!hole && (isMine || reveal || shownAtShowdown);
  const last = h?.last_actions[seat] ?? null;
  const total = info?.trustee ? 2000 : Number(state.room?.config?.action_timeout_ms ?? 15000);
  const net = h?.result ? h.result.scores[seat] : null;
  const winner = !!h?.result?.winners.includes(seat);

  let cards: ReactNode = null;
  if (inHand) {
    cards = faceUp ? (
      hole!.map((c, i) => <PlayingCard key={`${i}-${c}`} code={c} size={isMine ? 'md' : 'sm'} />)
    ) : (
      <>
        <PlayingCard back size="sm" />
        <PlayingCard back size="sm" />
      </>
    );
  }

  const cls = ['h-seat', onTurn ? 'on-turn' : '', folded ? 'folded' : '', isMine ? 'seat-mine' : '', winner ? 'h-winner' : '', !name ? 'h-empty' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      {last && h?.phase !== 'finished' && (
        <span className={`bubble h-act h-act-${last.action}`} key={last.key}>
          {holdemActionText(last, last.bet_before)}
          {last.auto ? '（代打）' : ''}
        </span>
      )}
      <div className="h-cards">{cards}</div>
      <div className="h-seat-head">
        <div className="avatar-wrap">
          {onTurn && showTimers && h?.remaining_ms !== null && h?.remaining_ms !== undefined ? (
            <CountdownRing remaining={h.remaining_ms} at={h.clock_at} total={total} size={36} />
          ) : (
            <div className={`avatar h-avatar${name ? '' : ' empty'}`}>{name ? name.slice(0, 1).toUpperCase() : seat}</div>
          )}
        </div>
        <div className="seat-meta">
          <div className="seat-name" title={name ?? '空位'}>
            {name ?? <span className="muted">空位</span>}
            {isMine && <span className="badge badge-me">我</span>}
          </div>
          <div className="h-stack">
            {inHand ? (
              <>
                筹码 <b>{h!.stacks[seat]}</b>
                {net !== null && net !== undefined && net !== 0 && (
                  <span className={`h-net ${net > 0 ? 'pos' : 'neg'}`}>{net > 0 ? `+${net}` : net}</span>
                )}
              </>
            ) : h && name ? (
              <span className="muted">下一手参加</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="seat-badges h-badges">
        {h && h.button === seat && <span className="h-marker h-dealer" title="庄位">D</span>}
        {h && h.small_blind_seat === seat && <span className="h-marker h-sb" title="小盲">SB</span>}
        {h && h.big_blind_seat === seat && <span className="h-marker h-bb" title="大盲">BB</span>}
        {folded && <span className="badge">弃牌</span>}
        {allIn && !folded && <span className="badge badge-warn">全下</span>}
        {info && <span className="badge">{info.kind === 'human' ? '真人' : 'Bot'}</span>}
        {info && (!h || (h.phase === 'finished' && state.room?.status !== 'playing')) && (
          <span className={`badge ${info.ready ? 'badge-ok' : ''}`}>{info.ready ? '已准备' : '未准备'}</span>
        )}
        {info?.trustee && <span className="badge badge-warn">托管</span>}
        {info && !info.connected && <span className="badge badge-warn">离线</span>}
        {info && <span className="badge" title="本房间累计筹码">累计 {info.score}</span>}
      </div>
      {props.seatExtra?.(seat)}
    </div>
  );
}

function HoldemResultPanel({ state, footer, reveal, mySeat }: { state: TableState; footer?: ReactNode; reveal: boolean; mySeat: number | null }) {
  const [open, setOpen] = useState(true);
  const h = state.holdem!;
  const r = h.result!;
  if (!open) {
    return (
      <button className="btn btn-small result-reopen" onClick={() => setOpen(true)}>
        查看结果
      </button>
    );
  }
  const show = new Map((r.showdown ?? []).map((e) => [e.seat, e]));
  const seats = h.stacks.flatMap((s, i) => (s === null ? [] : [i]));
  const names = r.winners.map((w) => seatName(state, w)).join('、');
  const bestOfWinner = r.showdown?.find((e) => r.winners.includes(e.seat));
  return (
    <div className="result-panel">
      <button className="result-close" onClick={() => setOpen(false)} aria-label="关闭">
        ×
      </button>
      <h3>{names ? `${names} 赢` : '本手结束'}</h3>
      <div className="result-meta">
        底池 {r.pot}
        {r.showdown ? ` · 摊牌${bestOfWinner ? `，${holdemRankLabel(bestOfWinner.rank, bestOfWinner.best)}` : ''}` : ' · 其他人弃牌，未摊牌'}
      </div>
      <table className="result-table">
        <tbody>
          {seats.map((s) => {
            const e = show.get(s);
            const sc = r.scores[s] ?? 0;
            const hole = e?.hole ?? (h.holes[s] && (mySeat === s || reveal) ? h.holes[s] : null);
            return (
              <tr key={s} className={r.winners.includes(s) ? 'winner' : ''}>
                <td>
                  {seatName(state, s)}
                  {h.folded[s] && <span className="badge">弃牌</span>}
                </td>
                <td className={`score ${sc > 0 ? 'pos' : sc < 0 ? 'neg' : ''}`}>
                  {sc > 0 ? '+' : ''}
                  {sc}
                </td>
                <td className="result-hand">
                  {hole ? (
                    <span className="h-result-hand">
                      <MiniCards cards={hole} />
                      {e && (
                        <span className="h-rank" title={e.best.join(' ')}>
                          {holdemRankLabel(e.rank, e.best)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

function MiniCards({ cards }: { cards: Card[] }) {
  return (
    <span className="mini-cards">
      {cards.map((c, i) => (
        <PlayingCard key={`${i}-${c}`} code={c} size="xs" />
      ))}
    </span>
  );
}

// ---------- action controls ----------

export interface HoldemControlsProps {
  legal: HoldemLegal;
  /** Own stack (to label calls that put you all-in). */
  stack: number | null;
  /** Own bet on this street. */
  bet: number;
  busy: boolean;
  /** Changes on every new turn; resets the raise amount. */
  turnKey: string | number;
  onAct: (action: HoldemAction, amount?: number) => void;
}

export function HoldemControls({ legal, stack, bet, busy, turnKey, onAct }: HoldemControlsProps) {
  const min = legal.min_raise_to;
  const max = legal.max_raise_to;
  const canRaise = min !== null && max !== null;
  const [amount, setAmount] = useState<number>(min ?? 0);
  useEffect(() => {
    setAmount(min ?? 0);
  }, [turnKey, min]);

  const clamp = (v: number) => (canRaise ? Math.min(max!, Math.max(min!, Math.round(v))) : v);
  // Pot-sized raise: call first, then raise by the pot after the call.
  const potAfterCall = legal.pot + legal.to_call;
  const potRaise = clamp(legal.current_bet + potAfterCall);
  const halfPotRaise = clamp(legal.current_bet + Math.round(potAfterCall / 2));
  const callAllIn = stack !== null && legal.to_call >= stack;
  const isBet = legal.current_bet === 0;
  const value = canRaise ? clamp(Number.isFinite(amount) ? amount : min!) : 0;
  const raiseLabel = canRaise && value === max ? `全下 ${value}` : isBet ? `下注 ${value}` : `加注到 ${value}`;

  return (
    <div className="controls holdem-controls">
      <div className="h-ctrl-row">
        <button className="btn" disabled={busy} onClick={() => onAct('fold')}>
          弃牌
        </button>
        {legal.can_check ? (
          <button className="btn btn-primary" disabled={busy} onClick={() => onAct('check')}>
            过牌
          </button>
        ) : (
          legal.to_call > 0 && (
            <button className="btn btn-primary" disabled={busy} onClick={() => onAct('call')}>
              跟注 {callAllIn && stack !== null ? stack : legal.to_call}
              {callAllIn ? '（全下）' : ''}
            </button>
          )
        )}
        {canRaise && (
          <button className="btn btn-primary" disabled={busy} onClick={() => onAct('raise', value)}>
            {raiseLabel}
          </button>
        )}
      </div>
      {canRaise && (
        <div className="h-ctrl-row h-raise-row">
          <input
            className="h-raise-slider"
            type="range"
            min={min!}
            max={max!}
            step={1}
            value={value}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label="加注到"
          />
          <input
            className="h-raise-input"
            type="number"
            min={min!}
            max={max!}
            step={1}
            value={Number.isFinite(amount) ? amount : ''}
            onChange={(e) => setAmount(Number(e.target.value))}
            onBlur={() => setAmount(value)}
            aria-label="加注额（本轮下注总额）"
          />
          <button className="btn btn-small" disabled={busy} onClick={() => setAmount(min!)}>
            最小{isBet ? '下注' : '加注'}
          </button>
          {halfPotRaise > min! && halfPotRaise < max! && (
            <button className="btn btn-small" disabled={busy} onClick={() => setAmount(halfPotRaise)}>
              半池
            </button>
          )}
          {potRaise > min! && potRaise < max! && (
            <button className="btn btn-small" disabled={busy} onClick={() => setAmount(potRaise)}>
              底池
            </button>
          )}
          <button className="btn btn-small" disabled={busy} onClick={() => setAmount(max!)}>
            全下
          </button>
          <span className="preview">
            {bet > 0 ? `已下 ${bet}，` : ''}再投入 {value - bet}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------- action log ----------

export function HoldemHistory({ state }: { state: TableState }) {
  const log: HoldemLogEntry[] = state.holdem?.log ?? [];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);
  const name = (s: number) => seatName(state, s);
  return (
    <div className="history" ref={ref}>
      {log.length === 0 && <div className="muted">暂无记录</div>}
      {log.map((e) => {
        switch (e.kind) {
          case 'start':
            return (
              <div key={e.key} className="log-row log-sys">
                新的一手{e.button >= 0 ? `，庄位 ${name(e.button)}` : ''}
              </div>
            );
          case 'act':
            return (
              <div key={e.key} className="log-row">
                <b>{name(e.rec.seat)}</b> {holdemActionText(e.rec, e.bet_before)}
                {e.auto && <span className="muted">（超时代打）</span>}
              </div>
            );
          case 'board':
            return (
              <div key={e.key} className="log-row log-sys">
                {HOLDEM_PHASE_LABELS[e.phase]} <MiniCards cards={e.cards} />
              </div>
            );
          case 'finish': {
            const r = e.result;
            return (
              <div key={e.key} className="log-row log-sys h-log-finish">
                <span>
                  {r.winners.map(name).join('、')} 赢得底池 {r.pot}
                  {!r.showdown && '（其他人弃牌）'}
                </span>
                {r.showdown?.map((s) => (
                  <span key={s.seat} className="h-log-show">
                    {name(s.seat)} <MiniCards cards={s.hole} /> {holdemRankLabel(s.rank, s.best)}
                  </span>
                ))}
              </div>
            );
          }
        }
      })}
    </div>
  );
}
