import { type ReactNode, useState } from 'react';
import type { Card } from '../api.ts';
import { type TableState, ddzBottomSize, ddzSeats, seatName } from '../state.ts';
import { Hand, PlayingCard, patternName, useNarrow } from './Card.tsx';
import { CountdownRing } from './Countdown.tsx';

export interface TableProps {
  state: TableState;
  /** Seat drawn at the bottom. */
  viewSeat: number;
  /** Show every known hand face up (god view / end of game). */
  reveal: boolean;
  showTimers: boolean;
  /** Viewer's own seat when playing (hand drawn large and clickable). */
  mySeat?: number | null;
  /** Selected occurrence keys of own hand (see cardKeys). */
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  /** Extra control under a seat (e.g. 入座 button for an empty seat). */
  seatExtra?: (seat: number) => ReactNode;
  /** Controls row above own hand (bid / play buttons). */
  controls?: ReactNode;
  /** Shown inside the result panel (e.g. replay link). */
  resultFooter?: ReactNode;
  /** Message in the middle when there is no game yet. */
  idleText?: string;
}

/** Seat count of the Dou Dizhu table (3 or 4). */
export function tableSeats(state: TableState): number {
  return state.game?.n ?? state.guandan?.n ?? state.gongzhu?.n ?? state.room?.seats.length ?? ddzSeats(state.gameType);
}

export function Table(props: TableProps) {
  const { state, viewSeat } = props;
  const n = tableSeats(state);
  // Play order goes counter-clockwise on screen: the next seat sits on the right.
  const right = (viewSeat + 1) % n;
  const top = n === 4 ? (viewSeat + 2) % n : null;
  const left = (viewSeat + n - 1) % n;
  return (
    <div className={`table${n === 4 ? ' table-4' : ''}`}>
      {top !== null && (
        <div className="seat-area seat-top">
          <SeatPanel {...props} seat={top} side />
        </div>
      )}
      <div className="seat-area seat-left">
        <SeatPanel {...props} seat={left} side />
      </div>
      <div className="table-center">
        <CenterInfo state={state} />
        {top !== null && (
          <div className="center-plays-top">
            <PlaySlot state={state} seat={top} pos="top" />
          </div>
        )}
        <div className="center-plays">
          <PlaySlot state={state} seat={left} pos="left" />
          <PlaySlot state={state} seat={right} pos="right" />
        </div>
        <div className="center-plays-bottom">
          <PlaySlot state={state} seat={viewSeat} pos="bottom" />
        </div>
        {!state.game && <div className="idle-text">{props.idleText ?? '等待开局'}</div>}
        {state.game?.phase === 'finished' && state.game.result && (
          <ResultPanel key={state.game.game_id} state={state} footer={props.resultFooter} />
        )}
      </div>
      <div className="seat-area seat-right">
        <SeatPanel {...props} seat={right} side />
      </div>
      <div className="seat-area seat-bottom">
        <SeatPanel {...props} seat={viewSeat} />
      </div>
    </div>
  );
}

function CenterInfo({ state }: { state: TableState }) {
  const g = state.game;
  const bottom = g?.bottom;
  const n = tableSeats(state);
  const spread = n === 4 ? 0.62 : 1.12;
  return (
    <div className="center-info">
      <div className={`bottom-cards bottom-${ddzBottomSize(n)}`} title="底牌">
        {bottom && bottom.length ? (
          <Hand cards={bottom} size="sm" spread={spread} />
        ) : (
          <Hand backs={ddzBottomSize(n)} size="sm" spread={spread} />
        )}
      </div>
      {g && (
        <div className="chips">
          <span className="chip chip-phase">{g.phase === 'bidding' ? '叫分中' : g.phase === 'playing' ? '出牌中' : '已结束'}</span>
          <span className="chip">叫分 {g.high_bid || '-'}</span>
          <span className="chip">倍数 ×{g.multiplier}</span>
          {g.redeals > 0 && <span className="chip">重发 {g.redeals}</span>}
        </div>
      )}
    </div>
  );
}

function PlaySlot({ state, seat, pos }: { state: TableState; seat: number; pos: 'left' | 'right' | 'bottom' | 'top' }) {
  const g = state.game;
  if (!g) return <div className={`play-slot play-${pos}`} />;
  let body: ReactNode = null;
  if (g.phase === 'bidding') {
    const b = g.last_bids[seat];
    if (b !== null && b !== undefined) body = <span className="bubble">{b === 0 ? '不叫' : `${b} 分`}</span>;
    else if (g.turn === seat) body = <span className="bubble thinking">叫分中…</span>;
  } else {
    const p = g.last_plays[seat];
    if (p) {
      body =
        p.cards.length === 0 ? (
          <span className="bubble pass">不出</span>
        ) : (
          <div className="played" key={p.key}>
            <Hand cards={p.cards} size="sm" spread={0.5} animate />
            <span className="pattern-name">
              {patternName(p.pattern, state.gameType)}
              {p.auto ? '（代出）' : ''}
            </span>
          </div>
        );
    } else if (g.turn === seat && g.phase === 'playing') {
      body = <span className="bubble thinking">思考中…</span>;
    }
  }
  return (
    <div className={`play-slot play-${pos}`} aria-label={`${seatName(state, seat)} 的出牌`}>
      {body}
    </div>
  );
}

function SeatPanel(props: TableProps & { seat: number; side?: boolean }) {
  const { state, seat, side, reveal, showTimers, mySeat } = props;
  const g = state.game;
  const info = state.room?.seats[seat] ?? null;
  const player = g?.players.find((p) => p.seat === seat);
  const name = info?.name ?? player?.name;
  const isMine = mySeat === seat;
  const narrow = useNarrow();
  const known = g?.hands[seat] ?? null;
  const left = g ? (known && (isMine || reveal || g.phase === 'finished') ? known.length : g.cards_left[seat] ?? 0) : 0;
  const onTurn = !!g && g.turn === seat && g.phase !== 'finished';
  const cfg = state.room?.config;
  const total = info?.trustee ? 2000 : g?.phase === 'bidding' ? (cfg?.bid_timeout_ms ?? 10000) : (cfg?.play_timeout_ms ?? 20000);

  const role =
    g && g.landlord !== null && g.landlord !== undefined ? (
      g.landlord === seat ? (
        <span className="badge badge-landlord">地主</span>
      ) : (
        <span className="badge badge-farmer">农民</span>
      )
    ) : null;

  let handView: ReactNode = null;
  if (g) {
    if (isMine && known) {
      handView = (
        <Hand
          cards={known}
          size="lg"
          selected={props.selected}
          onToggle={props.onToggle}
          rows={narrow && known.length > 12 ? 2 : 1}
          className="my-hand"
        />
      );
    } else if (known && (reveal || g.phase === 'finished')) {
      handView = <Hand cards={known} size={side ? 'xs' : 'md'} rows={side && known.length > 10 ? Math.ceil(known.length / 12) : 1} />;
    } else if (left > 0) {
      handView = side ? (
        <div className="back-stack" title={`剩余 ${left} 张`}>
          <PlayingCard back size="sm" />
          <span className="back-count">{left}</span>
        </div>
      ) : (
        <Hand backs={left} size="sm" spread={0.3} />
      );
    }
  }

  return (
    <div className={`seat${onTurn ? ' on-turn' : ''}${side ? ' seat-side' : ' seat-main'}${isMine ? ' seat-mine' : ''}`}>
      <div className="seat-head">
        <div className="avatar-wrap">
          {onTurn && showTimers && g?.remaining_ms !== null && g?.remaining_ms !== undefined ? (
            <CountdownRing remaining={g.remaining_ms} at={g.clock_at} total={total} size={side ? 40 : 44} />
          ) : (
            <div className={`avatar${name ? '' : ' empty'}`}>{name ? name.slice(0, 1).toUpperCase() : seat}</div>
          )}
        </div>
        <div className="seat-meta">
          <div className="seat-name" title={name ?? '空位'}>
            {name ?? <span className="muted">空位</span>}
            {isMine && <span className="badge badge-me">我</span>}
          </div>
          <div className="seat-badges">
            {role}
            {info && <span className="badge badge-kind">{info.kind === 'human' ? '真人' : 'Bot'}</span>}
            {info && !g && <span className={`badge ${info.ready ? 'badge-ok' : ''}`}>{info.ready ? '已准备' : '未准备'}</span>}
            {info && g?.phase === 'finished' && state.room?.status !== 'playing' && (
              <span className={`badge ${info.ready ? 'badge-ok' : ''}`}>{info.ready ? '已准备' : '未准备'}</span>
            )}
            {info?.trustee && <span className="badge badge-warn">托管</span>}
            {info && !info.connected && <span className="badge badge-warn">离线</span>}
          </div>
          <div className="seat-stats">
            {g && <span className="stat-left">剩 {left} 张</span>}
            {info && <span className="stat-score">积分 {info.score}</span>}
          </div>
        </div>
        {props.seatExtra?.(seat)}
      </div>
      {isMine && props.controls}
      <div className="seat-hand">{handView}</div>
    </div>
  );
}

function ResultPanel({ state, footer }: { state: TableState; footer?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const g = state.game!;
  const r = g.result!;
  if (!open) {
    return (
      <button className="btn btn-small result-reopen" onClick={() => setOpen(true)}>
        查看结果
      </button>
    );
  }
  const close = (
    <button className="result-close" onClick={() => setOpen(false)} aria-label="关闭">
      ×
    </button>
  );
  const n = g.n;
  if (r.kind === 'nobid') {
    return (
      <div className="result-panel">
        {close}
        <h3>流局</h3>
        <p>{n === 4 ? '四家都不叫' : '三家都不叫'}</p>
        {footer}
      </div>
    );
  }
  const title = r.winner === 'landlord' ? '地主胜' : '农民胜';
  return (
    <div className="result-panel">
      {close}
      <h3>
        {title}
        {r.spring && <span className="badge badge-warn">春天</span>}
        {r.anti_spring && <span className="badge badge-warn">反春</span>}
      </h3>
      <div className="result-meta">
        底分 {r.base} · 炸弹 {r.bombs} · 倍数 ×{r.multiplier}
      </div>
      <table className="result-table">
        <tbody>
          {Array.from({ length: n }, (_, s) => (
            <tr key={s} className={r.winner_seat === s ? 'winner' : ''}>
              <td>
                {seatName(state, s)}
                {r.landlord === s ? <span className="badge badge-landlord">地主</span> : null}
              </td>
              <td className={`score ${(r.scores[s] ?? 0) > 0 ? 'pos' : (r.scores[s] ?? 0) < 0 ? 'neg' : ''}`}>
                {(r.scores[s] ?? 0) > 0 ? '+' : ''}
                {r.scores[s] ?? 0}
              </td>
              <td className="result-hand">
                {g.hands[s] && g.hands[s]!.length > 0 ? <Hand cards={g.hands[s]!} size="xs" spread={0.5} /> : <span className="muted">出完</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  );
}
