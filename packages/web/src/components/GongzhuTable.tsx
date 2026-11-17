import { type ReactNode, useEffect, useRef, useState } from 'react';
import { isScoring } from '@ddz/engine';
import type { Card } from '../api.ts';
import {
  GZ_CARD_NAMES,
  type GongzhuView,
  SUIT_NAMES,
  exposableCards,
  gzResultSummary,
  handPoints,
  legalCards,
  signed,
} from '../gongzhuState.ts';
import { type TableState, seatName } from '../state.ts';
import { Hand, PlayingCard, cardsByKeys, useNarrow } from './Card.tsx';
import { CountdownRing } from './Countdown.tsx';

export interface GongzhuTableProps {
  state: TableState;
  /** Seat drawn at the bottom. */
  viewSeat: number;
  /** Show every known hand face up (replay god view). */
  reveal: boolean;
  showTimers: boolean;
  mySeat?: number | null;
  /** Selected occurrence keys of own hand (see cardKeys). */
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  /** Returns false for cards that cannot be played now (greyed out). */
  enabled?: (code: Card) => boolean;
  seatExtra?: (seat: number) => ReactNode;
  /** Controls row above own hand. */
  controls?: ReactNode;
  resultFooter?: ReactNode;
  idleText?: string;
}

const scoreCls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

export function GongzhuTable(props: GongzhuTableProps) {
  const { state, viewSeat } = props;
  const v = state.gongzhu;
  const right = (viewSeat + 1) % 4;
  const top = (viewSeat + 2) % 4;
  const left = (viewSeat + 3) % 4;
  return (
    <div className="table table-4 gz-table">
      <div className="seat-area seat-top">
        <SeatPanel {...props} seat={top} side />
      </div>
      <div className="seat-area seat-left">
        <SeatPanel {...props} seat={left} side />
      </div>
      <div className="table-center">
        {v && <CenterInfo state={state} v={v} />}
        <div className="center-plays-top">
          <PlaySlot state={state} seat={top} pos="top" />
        </div>
        <div className="center-plays gz-plays">
          <PlaySlot state={state} seat={left} pos="left" />
          <PlaySlot state={state} seat={right} pos="right" />
        </div>
        <div className="center-plays-bottom">
          <PlaySlot state={state} seat={viewSeat} pos="bottom" />
        </div>
        {!v && <div className="idle-text">{props.idleText ?? '等待开局'}</div>}
        {v?.phase === 'finished' && v.result && <ResultPanel key={v.game_id} state={state} v={v} footer={props.resultFooter} />}
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

function CenterInfo({ state, v }: { state: TableState; v: GongzhuView }) {
  const name = (s: number) => seatName(state, s);
  const last = v.tricks[v.tricks.length - 1];
  // The open trick is not in `tricks` yet; once finished, the last trick played.
  const trickNo = v.phase === 'finished' ? v.tricks.length : Math.min(13, v.tricks.length + 1);
  return (
    <div className="center-info gz-info">
      <div className="chips">
        <span className="chip">{v.phase === 'expose' ? '亮牌中' : v.phase === 'playing' ? '出牌中' : '已结束'}</span>
        <span className="chip">第 {v.hand_no} 局</span>
        {v.phase === 'expose' ? (
          <span className="chip">{name(v.first_leader)} 先出</span>
        ) : (
          <span className="chip">第 {trickNo} 墩</span>
        )}
        {last && last.winner !== null && v.phase !== 'finished' && <span className="chip">上一墩：{name(last.winner)} 收</span>}
      </div>
    </div>
  );
}

function PlaySlot({ state, seat, pos }: { state: TableState; seat: number; pos: 'left' | 'right' | 'bottom' | 'top' }) {
  const v = state.gongzhu;
  if (!v) return <div className={`play-slot play-${pos}`} />;
  let body: ReactNode = null;
  if (v.phase === 'expose') {
    const rec = v.exposes.find((e) => e.seat === seat);
    if (rec) {
      body =
        rec.cards.length === 0 ? (
          <span className="bubble pass">不亮{rec.auto ? '（代打）' : ''}</span>
        ) : (
          <div className="played gz-exposed-play">
            <Hand cards={rec.cards} size="sm" spread={0.7} animate />
            <span className="pattern-name">亮 {rec.cards.map((c) => GZ_CARD_NAMES[c] ?? c).join('、')}</span>
          </div>
        );
    } else if (v.turn === seat) {
      body = <span className="bubble thinking">亮牌中…</span>;
    }
  } else {
    const t = v.trick;
    const p = t?.plays.find((x) => x.seat === seat);
    if (t && p) {
      const won = t.winner === seat;
      const tags = [t.leader === seat ? '领出' : '', won ? '收' : '', p.auto ? '代出' : ''].filter(Boolean);
      body = (
        <div className={`played gz-played${won ? ' gz-won' : ''}`} key={`${v.tricks.length}-${p.card}`}>
          <PlayingCard code={p.card} size="md" className="gz-trick-card" />
          {tags.length > 0 && <span className="pattern-name">{tags.join(' · ')}</span>}
        </div>
      );
    } else if (v.turn === seat && v.phase === 'playing') {
      body = <span className="bubble thinking">思考中…</span>;
    }
  }
  return (
    <div className={`play-slot play-${pos}`} aria-label={`${seatName(state, seat)} 的出牌`}>
      {body}
    </div>
  );
}

function SeatPanel(props: GongzhuTableProps & { seat: number; side?: boolean }) {
  const { state, seat, side, reveal, showTimers, mySeat } = props;
  const v = state.gongzhu;
  const narrow = useNarrow();
  const info = state.room?.seats[seat] ?? null;
  const player = v?.players.find((p) => p.seat === seat);
  const name = info?.name ?? player?.name;
  const isMine = mySeat === seat;
  const known = v?.hands[seat] ?? null;
  const left = v ? (known && (isMine || reveal || v.phase === 'finished') ? known.length : (v.cards_left[seat] ?? 0)) : 0;
  const onTurn = !!v && v.turn === seat && v.phase !== 'finished';
  const total = info?.trustee ? 2000 : (state.room?.config?.play_timeout_ms ?? 20000);
  const exposed = v?.exposed[seat] ?? [];
  const taken = v?.taken[seat] ?? [];
  const points = v ? (handPoints(v)[seat] ?? 0) : 0;
  const tagOf = (c: Card) => (exposed.includes(c) ? '亮' : undefined);

  let handView: ReactNode = null;
  if (v) {
    if (isMine && known) {
      handView = (
        <Hand
          cards={known}
          size="lg"
          selected={props.selected}
          onToggle={props.onToggle}
          enabled={props.enabled}
          tagOf={tagOf}
          rows={narrow && known.length > 7 ? 2 : 1}
          className="my-hand"
        />
      );
    } else if (known && known.length > 0 && (reveal || v.phase === 'finished')) {
      handView = <Hand cards={known} size={side ? 'xs' : 'md'} tagOf={tagOf} rows={side && known.length > 7 ? 2 : 1} />;
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
    <div className={`seat gz-seat${onTurn ? ' on-turn' : ''}${side ? ' seat-side' : ' seat-main'}${isMine ? ' seat-mine' : ''}`}>
      <div className="seat-head">
        <div className="avatar-wrap">
          {onTurn && showTimers && v?.remaining_ms !== null && v?.remaining_ms !== undefined ? (
            <CountdownRing remaining={v.remaining_ms} at={v.clock_at} total={total} size={side ? 40 : 44} />
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
            {info && <span className="badge">{info.kind === 'human' ? '真人' : 'Bot'}</span>}
            {info && (!v || (v.phase === 'finished' && state.room?.status !== 'playing')) && (
              <span className={`badge ${info.ready ? 'badge-ok' : ''}`}>{info.ready ? '已准备' : '未准备'}</span>
            )}
            {info?.trustee && <span className="badge badge-warn">托管</span>}
            {info && !info.connected && <span className="badge badge-warn">离线</span>}
            {exposed.map((c) => (
              <span key={c} className="badge gz-expose-badge" title={`亮了 ${GZ_CARD_NAMES[c] ?? c}`}>
                亮{GZ_CARD_NAMES[c] ?? c}
              </span>
            ))}
          </div>
          <div className="seat-stats">
            {v && <span>剩 {left} 张</span>}
            {v && (
              <span title="本局开始前的累计分">
                累计 <b className={scoreCls(v.totals[seat] ?? 0)}>{v.totals[seat] ?? 0}</b>
              </span>
            )}
            {v && v.phase !== 'expose' && (
              <span title="已收分牌的本局得分">
                本局 <b className={scoreCls(points)}>{signed(points)}</b>
              </span>
            )}
            {info && <span>积分 {info.score}</span>}
          </div>
          {taken.length > 0 && (
            <div className="gz-taken" aria-label="已收的分牌">
              <span className="gz-taken-label">收</span>
              <Hand cards={taken} size="xs" spread={0.45} />
            </div>
          )}
        </div>
        {props.seatExtra?.(seat)}
      </div>
      {isMine && props.controls}
      <div className="seat-hand">{handView}</div>
    </div>
  );
}

function ResultPanel({ state, v, footer }: { state: TableState; v: GongzhuView; footer?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const r = v.result!;
  if (!open) {
    return (
      <button className="btn btn-small result-reopen" onClick={() => setOpen(true)}>
        查看结果
      </button>
    );
  }
  const name = (s: number) => seatName(state, s);
  const order = [0, 1, 2, 3].sort((a, b) => (r.points[b] ?? 0) - (r.points[a] ?? 0));
  return (
    <div className="result-panel gz-result">
      <button className="result-close" onClick={() => setOpen(false)} aria-label="关闭">
        ×
      </button>
      <h3>{r.match_over ? `${r.losers.map(name).join('、')} 累计到 -1000，本场结束` : `第 ${v.hand_no} 局结束`}</h3>
      <div className="result-meta">
        {r.all_hearts !== null && r.all_hearts !== undefined && <span className="badge badge-warn">{name(r.all_hearts)} 全红</span>}{' '}
        {r.pig !== null && r.pig !== undefined && <>{name(r.pig)} 收猪{r.match_over ? '' : '，下一局先出'}</>}
        {r.pig === null && '没人收猪'}
        {r.match_over && <> · 下一局重新开始，累计清零</>}
      </div>
      <table className="result-table">
        <tbody>
          {order.map((s) => {
            const p = r.points[s] ?? 0;
            const loser = r.losers.includes(s);
            return (
              <tr key={s} className={p === Math.max(...r.points) && !loser ? 'winner' : ''}>
                <td>
                  {name(s)}
                  {r.exposed[s]?.length ? <span className="badge gz-expose-badge">亮{r.exposed[s]!.map((c) => GZ_CARD_NAMES[c] ?? c).join('、')}</span> : null}
                  {loser && <span className="badge badge-warn">出局</span>}
                </td>
                <td className="result-hand">
                  {r.taken[s]?.length ? <Hand cards={r.taken[s]!} size="xs" spread={0.5} /> : <span className="muted">没收分牌</span>}
                </td>
                <td className={`score ${scoreCls(p)}`}>{signed(p)}</td>
                <td className="gz-total" title="累计分">
                  {r.totals_before[s] ?? 0} → <b className={scoreCls(r.totals_after[s] ?? 0)}>{r.totals_after[s] ?? 0}</b>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="result-meta">排行榜得分 {r.scores.map((x, s) => `${name(s)} ${signed(x)}`).join(' · ')}</div>
      {footer}
    </div>
  );
}

// ---------- controls ----------

export interface GongzhuControlsProps {
  state: TableState;
  mySeat: number;
  selected: Set<string>;
  busy: boolean;
  onExpose: (cards: Card[]) => void;
  onPlay: (card: Card) => void;
  onLeave: () => void;
}

/** Expose / play controls for the seated player (shown while the hand is running). */
export function GongzhuControls({ state, mySeat, selected, busy, onExpose, onPlay, onLeave }: GongzhuControlsProps) {
  const v = state.gongzhu!;
  const hand = v.hands[mySeat] ?? [];
  const myTurn = v.turn === mySeat && v.phase !== 'finished';
  /** Cards picked to expose in this turn. */
  const [picks, setPicks] = useState<Set<Card>>(new Set());
  useEffect(() => {
    setPicks(new Set());
  }, [v.turn_seq, v.game_id]);
  const name = (s: number) => seatName(state, s);
  const leaveBtn = (
    <button className="btn btn-small" disabled={busy} onClick={onLeave}>
      离开
    </button>
  );

  if (v.phase === 'expose') {
    if (!myTurn) {
      return (
        <div className="controls controls-waiting">
          <span className="muted">{v.turn !== null ? `等待 ${name(v.turn)} 亮牌` : '等待亮牌'}</span>
          {leaveBtn}
        </div>
      );
    }
    const options = exposableCards(v, mySeat);
    const toggle = (c: Card) =>
      setPicks((p) => {
        const next = new Set(p);
        if (next.has(c)) next.delete(c);
        else next.add(c);
        return next;
      });
    return (
      <div className="controls gz-controls">
        {options.length === 0 ? (
          <span className="preview">没有可亮的牌</span>
        ) : (
          <span className="gz-expose-opts" role="group" aria-label="选择要亮的牌">
            {options.map((c) => (
              <button
                key={c}
                className={`btn btn-small gz-expose-opt${picks.has(c) ? ' btn-primary' : ''}`}
                aria-pressed={picks.has(c)}
                onClick={() => toggle(c)}
              >
                <PlayingCard code={c} size="xs" />
                {GZ_CARD_NAMES[c] ?? c}
              </button>
            ))}
          </span>
        )}
        <button className="btn" disabled={busy} onClick={() => onExpose([])}>
          不亮
        </button>
        {options.length > 0 && (
          <button className="btn btn-primary" disabled={busy || picks.size === 0} onClick={() => onExpose(options.filter((c) => picks.has(c)))}>
            亮牌
          </button>
        )}
      </div>
    );
  }

  if (!myTurn) {
    return (
      <div className="controls controls-waiting">
        <span className="muted">{v.turn !== null ? `等待 ${name(v.turn)} 出牌` : '等待其他玩家出牌'}</span>
        {leaveBtn}
      </div>
    );
  }

  const legal = new Set(legalCards(v, mySeat));
  const sel = cardsByKeys(hand, selected);
  const card = sel.length === 1 && legal.has(sel[0]!) ? sel[0]! : null;
  const t = v.trick;
  const led = t && t.winner === null && t.plays[0] ? t.plays[0].card[1]! : null;
  return (
    <div className="controls gz-controls">
      <span className="preview">{led ? `跟 ${SUIT_NAMES[led] ?? led}` : '由你领出'}</span>
      <button className="btn btn-primary" disabled={busy || !card} onClick={() => card && onPlay(card)}>
        出牌
      </button>
      {card ? <PlayingCard code={card} size="xs" /> : <span className="muted">点一张亮着的牌</span>}
    </div>
  );
}

/** Own-hand click handler: one card at a time. */
export function gzToggle(setSelected: (f: (s: Set<string>) => Set<string>) => void) {
  return (k: string) => setSelected((sel) => (sel.has(k) ? new Set() : new Set([k])));
}

/** Cards the seated player may click right now (the legal cards on their turn). */
export function gzEnabled(v: GongzhuView, mySeat: number): ((c: Card) => boolean) | undefined {
  if (v.phase !== 'playing' || v.turn !== mySeat) return undefined;
  const ok = new Set(legalCards(v, mySeat));
  return (c) => ok.has(c);
}

// ---------- log ----------

export function GongzhuHistory({ state }: { state: TableState }) {
  const v = state.gongzhu;
  const ref = useRef<HTMLDivElement>(null);
  const size = v ? v.exposes.length + v.tricks.length * 5 + (v.trick?.plays.length ?? 0) + (v.result ? 1 : 0) : 0;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [size]);
  if (!v) {
    return (
      <div className="history" ref={ref}>
        <div className="muted">暂无记录</div>
      </div>
    );
  }
  const name = (s: number) => seatName(state, s);
  const open = v.trick && v.trick.winner === null ? v.trick : null;
  const tricks = open ? [...v.tricks, open] : v.tricks;
  const r = v.result;
  return (
    <div className="history" ref={ref}>
      <div className="log-row log-sys">
        第 {v.hand_no} 局开始，{name(v.first_leader)} 先出
      </div>
      {v.exposes.map((e) => (
        <div key={`x${e.seat}`} className="log-row log-sys">
          <b>{name(e.seat)}</b>{' '}
          {e.cards.length === 0 ? (
            <span className="muted">不亮</span>
          ) : (
            <>
              亮 {e.cards.map((c) => GZ_CARD_NAMES[c] ?? c).join('、')}
              <Hand cards={e.cards} size="xs" spread={0.6} className="inline-hand" />
            </>
          )}
          {e.auto && <span className="muted">（代打）</span>}
        </div>
      ))}
      {tricks.map((t, i) => {
        const scoring = t.winner !== null ? t.plays.map((p) => p.card).filter(isScoring) : [];
        return (
          <div key={`t${i}`} className="log-row gz-log-trick">
            <span className="log-pattern">第 {i + 1} 墩</span>
            {t.plays.map((p) => (
              <span key={p.seat} className={`gz-log-play${t.winner === p.seat ? ' gz-log-win' : ''}`}>
                {name(p.seat)} <PlayingCard code={p.card} size="xs" />
                {p.auto && <span className="muted">（代出）</span>}
              </span>
            ))}
            {t.winner !== null && (
              <span className="gz-log-play">
                → <b>{name(t.winner)}</b> 收{scoring.length ? ` ${scoring.length} 张分牌` : ''}
              </span>
            )}
          </div>
        );
      })}
      {r && (
        <div className="log-row log-sys gz-log-finish">
          <span>本局得分 {r.points.map((p, s) => `${name(s)} ${signed(p)}`).join('、')}</span>
          <span>累计 {r.totals_after.map((p, s) => `${name(s)} ${p}`).join('、')}</span>
          {gzResultSummary(r) && <span>{gzResultSummary(r)}</span>}
        </div>
      )}
    </div>
  );
}
