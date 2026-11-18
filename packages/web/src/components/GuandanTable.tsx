import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  type GdPattern,
  beatsGd,
  identifyGd,
  isBombLike,
  legalMovesGd,
  resolveGd,
  strength,
  wildcardOf,
} from '@ddz/engine';
import type { Card } from '../api.ts';
import {
  type GdLogEntry,
  type GuandanView,
  PLACE_LABELS,
  gdPartnerOf,
  gdResultSummary,
  gdTeamOf,
  levelLabel,
  pendingReturn,
  returnableCards,
} from '../guandanState.ts';
import { type TableState, seatName } from '../state.ts';
import { Hand, PlayingCard, cardsByKeys, keysForCards, patternName, useNarrow } from './Card.tsx';
import { CountdownRing } from './Countdown.tsx';
import { toast } from './Toast.tsx';

export interface GuandanTableProps {
  state: TableState;
  /** Seat drawn at the bottom (the partner sits at the top). */
  viewSeat: number;
  /** Show every known hand face up (replay god view). */
  reveal: boolean;
  showTimers: boolean;
  mySeat?: number | null;
  /** Selected occurrence keys of own hand (see cardKeys). */
  selected?: Set<string>;
  onToggle?: (key: string) => void;
  /** Returns false for cards that cannot be clicked (return phase). */
  enabled?: (code: Card) => boolean;
  seatExtra?: (seat: number) => ReactNode;
  /** Controls row above own hand. */
  controls?: ReactNode;
  resultFooter?: ReactNode;
  idleText?: string;
}


const TEAM_NAMES = ['0 队', '1 队'];

function TeamBadge({ seat }: { seat: number }) {
  const t = gdTeamOf(seat);
  return <span className={`badge badge-team badge-team${t}`}>{TEAM_NAMES[t]}</span>;
}

/** Place of a seat that is out (1-based), or 0. */
function placeOf(v: GuandanView, seat: number): number {
  const i = v.order.indexOf(seat);
  if (i < 0) return 0;
  return v.phase === 'finished' || v.cards_left[seat] === 0 ? i + 1 : 0;
}

export function GuandanTable(props: GuandanTableProps) {
  const { state, viewSeat } = props;
  const v = state.guandan;
  const right = (viewSeat + 1) % 4;
  const top = (viewSeat + 2) % 4;
  const left = (viewSeat + 3) % 4;
  return (
    <div className="table table-4 gd-table">
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
        <div className="center-plays">
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

function CenterInfo({ state, v }: { state: TableState; v: GuandanView }) {
  const name = (s: number) => seatName(state, s);
  const wild = wildcardOf(v.level);
  const atA = v.level === 'A';
  const tries = v.a_attempts[v.level_team] ?? 0;
  const pending = pendingReturn(v);
  return (
    <div className="center-info gd-info">
      <div className="chips">
        <span className="chip chip-phase">{v.phase === 'return' ? '还贡中' : v.phase === 'playing' ? '出牌中' : '已结束'}</span>
        <span className="chip">第 {v.hand_no} 局</span>
        <span className={`chip gd-level-chip gd-team${v.level_team}`}>
          打 {levelLabel(v.level)}（{TEAM_NAMES[v.level_team]}）
        </span>
        <span className="chip">
          <span className="gd-team-dot gd-team0" />0 队 {levelLabel(v.team_levels[0])} · <span className="gd-team-dot gd-team1" />1 队{' '}
          {levelLabel(v.team_levels[1])}
        </span>
        {atA && <span className="chip chip-warn">打 A 第 {Math.min(3, tries + 1)}/3 次</span>}
        <span className="chip gd-wild-chip" title="逢人配：红桃级牌可以当除大小王外的任意牌">
          逢人配 <PlayingCard code={wild} size="xs" wild />
        </span>
      </div>
      {v.tribute && (
        <div className="gd-tribute" aria-label="进贡与还贡">
          {v.tribute.anti ? (
            <span className="gd-xfer gd-anti">抗贡：不进贡也不还贡</span>
          ) : (
            <>
              {v.tribute.tributes.map((t, i) => (
                <span key={`t${i}`} className="gd-xfer">
                  <span className="gd-xfer-kind">进贡</span>
                  {name(t.from)} → {name(t.to)} <PlayingCard code={t.card} size="xs" />
                </span>
              ))}
              {v.returns.map((t, i) => (
                <span key={`r${i}`} className="gd-xfer">
                  <span className="gd-xfer-kind gd-ret">还贡</span>
                  {name(t.from)} → {name(t.to)} <PlayingCard code={t.card} size="xs" />
                  {t.auto ? <span className="muted">（代还）</span> : null}
                </span>
              ))}
              {pending && (
                <span className="gd-xfer muted">
                  等待 {name(pending.from)} 还贡给 {name(pending.to)}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PlaySlot({ state, seat, pos }: { state: TableState; seat: number; pos: 'left' | 'right' | 'bottom' | 'top' }) {
  const v = state.guandan;
  if (!v) return <div className={`play-slot play-${pos}`} />;
  let body: ReactNode = null;
  const p = v.last_plays[seat];
  const place = placeOf(v, seat);
  if (p && v.phase !== 'finished') {
    body =
      p.cards.length === 0 ? (
        <span className="bubble pass">不出{p.auto ? '（代打）' : ''}</span>
      ) : (
        <div className="played" key={p.key}>
          <Hand cards={p.cards} size="sm" spread={0.5} animate wild={wildcardOf(v.level)} />
          <span className="pattern-name">
            {patternName(p.pattern, 'guandan')}
            {p.auto ? '（代出）' : ''}
            {place ? ` · ${PLACE_LABELS[place - 1]}` : ''}
          </span>
        </div>
      );
  } else if (place) {
    body = <span className={`bubble gd-place gd-place-${place}`}>{PLACE_LABELS[place - 1]}</span>;
  } else if (v.turn === seat) {
    body = <span className="bubble thinking">{v.phase === 'return' ? '还贡中…' : '思考中…'}</span>;
  }
  return (
    <div className={`play-slot play-${pos}`} aria-label={`${seatName(state, seat)} 的出牌`}>
      {body}
    </div>
  );
}

function SeatPanel(props: GuandanTableProps & { seat: number; side?: boolean }) {
  const { state, seat, side, reveal, showTimers, mySeat, viewSeat } = props;
  const v = state.guandan;
  const narrow = useNarrow();
  const info = state.room?.seats[seat] ?? null;
  const player = v?.players.find((p) => p.seat === seat);
  const name = info?.name ?? player?.name;
  const isMine = mySeat === seat;
  const known = v?.hands[seat] ?? null;
  const left = v ? (known && (isMine || reveal || v.phase === 'finished') ? known.length : (v.cards_left[seat] ?? 0)) : 0;
  const onTurn = !!v && v.turn === seat && v.phase !== 'finished';
  const total = info?.trustee ? 2000 : (state.room?.config?.play_timeout_ms ?? 20000);
  const place = v ? placeOf(v, seat) : 0;
  const isPartner = seat === gdPartnerOf(mySeat ?? viewSeat) && seat !== (mySeat ?? viewSeat);
  const wild = v ? wildcardOf(v.level) : undefined;

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
          wild={wild}
          rows={narrow && known.length > 14 ? 2 : 1}
          className="my-hand"
        />
      );
    } else if (known && known.length > 0 && (reveal || v.phase === 'finished')) {
      handView = <Hand cards={known} size={side ? 'xs' : 'md'} wild={wild} rows={side && known.length > 10 ? Math.ceil(known.length / 14) : 1} />;
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
    <div
      className={`seat gd-seat gd-seat-team${gdTeamOf(seat)}${onTurn ? ' on-turn' : ''}${side ? ' seat-side' : ' seat-main'}${isMine ? ' seat-mine' : ''}${place ? ' gd-out' : ''}`}
    >
      <div className="seat-head">
        <div className="avatar-wrap">
          {onTurn && showTimers && v?.remaining_ms !== null && v?.remaining_ms !== undefined ? (
            <CountdownRing remaining={v.remaining_ms} at={v.clock_at} total={total} size={side ? 40 : 44} />
          ) : (
            <div className={`avatar gd-avatar${name ? '' : ' empty'}`}>{name ? name.slice(0, 1).toUpperCase() : seat}</div>
          )}
        </div>
        <div className="seat-meta">
          <div className="seat-name" title={name ?? '空位'}>
            {name ?? <span className="muted">空位</span>}
            {isMine && <span className="badge badge-me">我</span>}
          </div>
          <div className="seat-badges">
            <TeamBadge seat={seat} />
            {isPartner && <span className="badge badge-partner">队友</span>}
            {place > 0 && <span className={`badge gd-place gd-place-${place}`}>{PLACE_LABELS[place - 1]}</span>}
            {info && <span className="badge badge-kind">{info.kind === 'human' ? '真人' : 'Bot'}</span>}
            {info && (!v || (v.phase === 'finished' && state.room?.status !== 'playing')) && (
              <span className={`badge ${info.ready ? 'badge-ok' : ''}`}>{info.ready ? '已准备' : '未准备'}</span>
            )}
            {info?.trustee && <span className="badge badge-warn">托管</span>}
            {info && !info.connected && <span className="badge badge-warn">离线</span>}
          </div>
          <div className="seat-stats">
            {v && <span className="stat-left">剩 {left} 张</span>}
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

function ResultPanel({ state, v, footer }: { state: TableState; v: GuandanView; footer?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const r = v.result!;
  if (!open) {
    return (
      <button className="btn btn-small result-reopen" onClick={() => setOpen(true)}>
        查看结果
      </button>
    );
  }
  const won = r.match_winner !== null && r.match_winner !== undefined;
  const lv = (t: 0 | 1) => {
    const a = r.team_levels_before[t];
    const b = r.team_levels_after[t];
    return a === b ? levelLabel(a) : `${levelLabel(a)} → ${levelLabel(b)}`;
  };
  return (
    <div className="result-panel gd-result">
      <button className="result-close" onClick={() => setOpen(false)} aria-label="关闭">
        ×
      </button>
      <h3>
        {won ? `${r.match_winner} 队过 A，赢下本场！` : `${r.winner_team} 队胜，升 ${r.upgrade} 级`}
      </h3>
      <div className="result-meta">
        打 {levelLabel(r.level)} · 0 队 {lv(0)} · 1 队 {lv(1)}
        <br />
        下一局：{won ? '新的一场，两队从 2 打起' : `打 ${levelLabel(r.team_levels_after[r.level_team_next])}（${r.level_team_next} 队）`}
        {!won && (r.a_attempts[0] > 0 || r.a_attempts[1] > 0) && ` · 打 A 次数 ${r.a_attempts[0]} / ${r.a_attempts[1]}`}
      </div>
      <table className="result-table">
        <tbody>
          {r.order.map((s, i) => (
            <tr key={s} className={gdTeamOf(s) === r.winner_team ? 'winner' : ''}>
              <td>
                <span className={`badge gd-place gd-place-${i + 1}`}>{PLACE_LABELS[i]}</span> {seatName(state, s)}
                <TeamBadge seat={s} />
              </td>
              <td className={`score ${(r.scores[s] ?? 0) > 0 ? 'pos' : (r.scores[s] ?? 0) < 0 ? 'neg' : ''}`}>
                {(r.scores[s] ?? 0) > 0 ? '+' : ''}
                {r.scores[s] ?? 0}
              </td>
              <td className="result-hand">
                {v.hands[s] && v.hands[s]!.length > 0 ? (
                  <Hand cards={v.hands[s]!} size="xs" spread={0.5} wild={wildcardOf(v.level)} />
                ) : (
                  <span className="muted">{(v.cards_left[s] ?? 0) > 0 ? `剩 ${v.cards_left[s]} 张` : '出完'}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

// ---------- controls ----------

const RANK_NAMES: Record<string, string> = { T: '10', BJ: '小王', RJ: '大王' };
const SEQ_TYPES = new Set(['straight', 'pair_chain', 'plane', 'straight_flush']);

/** Pattern name with its rank, e.g. "对子 7", "顺子 到 9", "5 张炸弹 Q". */
export function gdPatternLabel(p: GdPattern): string {
  const name = patternName(p, 'guandan');
  if (p.type === 'rocket') return name;
  const r = RANK_NAMES[p.rank] ?? p.rank;
  return SEQ_TYPES.has(p.type) ? `${name} 到 ${r}` : `${name} ${r}`;
}

const patKey = (p: { type: string; rank: string }) => `${p.type}:${p.rank}`;

export interface GuandanControlsProps {
  state: TableState;
  mySeat: number;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  busy: boolean;
  onPlay: (cards: Card[], pattern?: { type: string; rank: string }) => void;
  onReturn: (card: Card) => void;
  onLeave: () => void;
}

/** Return / play controls for the seated player (shown while the hand is running). */
export function GuandanControls({ state, mySeat, selected, setSelected, busy, onPlay, onReturn, onLeave }: GuandanControlsProps) {
  const v = state.guandan!;
  const hand = v.hands[mySeat] ?? [];
  const myTurn = v.turn === mySeat && v.phase !== 'finished';
  const level = v.level;
  const sel = cardsByKeys(hand, selected);
  const selKey = [...selected].sort().join(',');
  const hintIdx = useRef(0);
  /** Interpretation picked by the player (or by a hint) for the selection `selKey`. */
  const [choice, setChoice] = useState<{ selKey: string; key: string } | null>(null);
  useEffect(() => {
    hintIdx.current = 0;
  }, [v.turn_seq, v.game_id]);

  const toBeat = v.phase === 'playing' && v.can_pass && v.to_beat?.pattern ? (v.to_beat.pattern as GdPattern) : null;
  const analysis = useMemo(() => {
    if (sel.length === 0) return { all: [] as GdPattern[], cands: [] as GdPattern[], def: null as GdPattern | null };
    const all = identifyGd(sel, level);
    const cands = (toBeat ? all.filter((p) => beatsGd(p, toBeat, level)) : all).sort((a, b) => strength(a, level) - strength(b, level));
    const r = resolveGd(sel, toBeat, level);
    return { all, cands, def: r.ok ? r.pattern : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.join(','), level, toBeat?.type, toBeat?.rank, toBeat?.length]);

  const name = (s: number) => seatName(state, s);
  const leaveBtn = (
    <button className="btn btn-small" disabled={busy} onClick={onLeave}>
      离开
    </button>
  );

  if (v.phase === 'return') {
    const pending = pendingReturn(v);
    if (myTurn && pending && pending.from === mySeat) {
      const ok = returnableCards(hand, level);
      const card = sel.length === 1 && ok.has(sel[0]!) ? sel[0]! : null;
      return (
        <div className="controls gd-controls">
          <span className="preview">选一张牌还给 {name(pending.to)}</span>
          <button className="btn btn-primary" disabled={busy || !card} onClick={() => card && onReturn(card)}>
            还贡
          </button>
          {card && <PlayingCard code={card} size="xs" />}
        </div>
      );
    }
    return (
      <div className="controls controls-waiting">
        {leaveBtn}
      </div>
    );
  }

  if (!myTurn) {
    const place = placeOf(v, mySeat);
    return (
      <div className="controls controls-waiting">
        {place && <span className="muted">你已出完（{PLACE_LABELS[place - 1]}），等待本局结束</span>}
        {sel.length > 0 && analysis.all.length > 0 && <span className="preview">{gdPatternLabel(analysis.def ?? analysis.all[0]!)}</span>}
        {leaveBtn}
      </div>
    );
  }

  const chosen =
    (choice && choice.selKey === selKey ? analysis.cands.find((p) => patKey(p) === choice.key) : undefined) ?? analysis.def ?? undefined;
  let preview: ReactNode = null;
  if (sel.length > 0) {
    if (analysis.all.length === 0) preview = <span className="preview gd-bad">不成牌型</span>;
    else if (analysis.cands.length === 0) preview = <span className="preview gd-bad">压不过上家</span>;
    else if (analysis.cands.length === 1) preview = <span className="preview">{gdPatternLabel(analysis.cands[0]!)}</span>;
    else
      preview = (
        <span className="gd-choices" role="radiogroup" aria-label="按哪种牌型出">
          {analysis.cands.map((p) => (
            <button
              key={patKey(p)}
              role="radio"
              aria-checked={chosen ? patKey(chosen) === patKey(p) : false}
              className={`btn btn-small gd-choice${chosen && patKey(chosen) === patKey(p) ? ' btn-primary' : ''}`}
              onClick={() => setChoice({ selKey, key: patKey(p) })}
            >
              {gdPatternLabel(p)}
            </button>
          ))}
        </span>
      );
  }

  const hint = () => {
    const moves = legalMovesGd(hand, toBeat, level).sort(
      (a, b) =>
        Number(isBombLike(a.pattern)) - Number(isBombLike(b.pattern)) ||
        strength(a.pattern, level) - strength(b.pattern, level) ||
        a.cards.length - b.cards.length,
    );
    if (moves.length === 0) {
      toast('没有能压过上家的牌', 'info');
      setSelected(new Set());
      return;
    }
    const m = moves[hintIdx.current % moves.length]!;
    hintIdx.current++;
    const keys = keysForCards(hand, m.cards);
    setSelected(keys);
    setChoice({ selKey: [...keys].sort().join(','), key: patKey(m.pattern) });
  };

  const canPlay = sel.length > 0 && !!chosen;
  return (
    <div className="controls gd-controls">
      <button className="btn" disabled={busy || !v.can_pass} onClick={() => onPlay([])}>
        不出
      </button>
      <button className="btn" disabled={busy} onClick={hint}>
        提示
      </button>
      <button
        className="btn btn-primary"
        disabled={busy || !canPlay}
        onClick={() => chosen && onPlay(sel, { type: chosen.type, rank: chosen.rank })}
      >
        出牌
      </button>
      {preview}
    </div>
  );
}

/** Own-hand click handler: single choice in the return phase, multi-select otherwise. */
export function gdToggle(v: GuandanView, setSelected: (f: (s: Set<string>) => Set<string>) => void) {
  return (k: string) =>
    setSelected((sel) => {
      if (v.phase === 'return') return sel.has(k) ? new Set() : new Set([k]);
      const next = new Set(sel);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
}

/** Cards the seated player may click right now (only returnable cards while owing a return). */
export function gdEnabled(v: GuandanView, mySeat: number): ((c: Card) => boolean) | undefined {
  const pending = pendingReturn(v);
  if (!pending || pending.from !== mySeat || v.turn !== mySeat) return undefined;
  const ok = returnableCards(v.hands[mySeat] ?? [], v.level);
  return (c) => ok.has(c);
}

// ---------- log ----------

export function GuandanHistory({ state }: { state: TableState }) {
  const log: GdLogEntry[] = state.guandan?.log ?? [];
  const wild = state.guandan ? wildcardOf(state.guandan.level) : undefined;
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
                第 {e.hand_no} 局开始，打 {levelLabel(e.level)}（{TEAM_NAMES[e.level_team]}主打）
              </div>
            );
          case 'tribute':
            return e.anti ? (
              <div key={e.key} className="log-row log-sys">
                抗贡：不进贡也不还贡
              </div>
            ) : (
              <div key={e.key} className="log-row log-sys gd-log-xfers">
                {e.tributes.map((t, i) => (
                  <span key={i}>
                    <b>{name(t.from)}</b> 进贡给 <b>{name(t.to)}</b> <PlayingCard code={t.card} size="xs" />
                  </span>
                ))}
              </div>
            );
          case 'return':
            return (
              <div key={e.key} className="log-row log-sys">
                <b>{name(e.t.from)}</b> 还贡给 <b>{name(e.t.to)}</b> <PlayingCard code={e.t.card} size="xs" />
                {e.t.auto && <span className="muted">（代还）</span>}
              </div>
            );
          case 'play':
            return (
              <div key={e.key} className="log-row">
                <b>{name(e.seat)}</b>{' '}
                {e.cards.length === 0 ? (
                  <span className="muted">不出</span>
                ) : (
                  <>
                    <span className="log-pattern">{patternName(e.pattern, 'guandan')}</span>
                    <Hand cards={e.cards} size="xs" spread={0.6} className="inline-hand" wild={wild} />
                  </>
                )}
                {e.auto && <span className="muted">（代出）</span>}
              </div>
            );
          case 'out':
            return (
              <div key={e.key} className="log-row log-sys">
                <b>{name(e.seat)}</b> 出完，<span className={`badge gd-place gd-place-${e.place}`}>{PLACE_LABELS[e.place - 1]}</span>
              </div>
            );
          case 'finish': {
            const r = e.result;
            return (
              <div key={e.key} className="log-row log-sys gd-log-finish">
                <span>
                  名次 {r.order.map((s, i) => `${PLACE_LABELS[i]} ${name(s)}`).join('、')}
                </span>
                <span>
                  {gdResultSummary(r)}；0 队 {levelLabel(r.team_levels_before[0])}→{levelLabel(r.team_levels_after[0])}，1 队{' '}
                  {levelLabel(r.team_levels_before[1])}→{levelLabel(r.team_levels_after[1])}
                  {r.match_winner !== null && r.match_winner !== undefined ? `，${r.match_winner} 队赢下本场比赛` : ''}
                </span>
                <span>得分 {r.scores.join(' / ')}</span>
              </div>
            );
          }
        }
      })}
    </div>
  );
}

