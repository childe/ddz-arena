import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type Move,
  type Move4,
  type Pattern4,
  RANK_LABELS,
  identify,
  identify4,
  legalMoves,
  legalMoves4,
  preferred,
  preferred4,
} from '@ddz/engine';
import { type Card, type HoldemAction, type Room, type WsEvent, ApiError, GAME_LABELS, api, errorText } from '../api.ts';
import { cardKeys, cardsByKeys, keysForCards, patternName } from '../components/Card.tsx';
import { GuestForm } from '../components/Guest.tsx';
import { History } from '../components/History.tsx';
import { HoldemControls, HoldemHistory, HoldemTable, holdemSeats } from '../components/HoldemTable.tsx';
import { Table, tableSeats } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { useGuest } from '../guest.ts';
import { href } from '../router.ts';
import { type OwnView, type TableState, applyEvent, emptyTable, tableFromSnapshot } from '../state.ts';
import { LiveSocket, type SocketStatus } from '../ws.ts';
import { GameList } from './Lobby.tsx';

type Action =
  | { t: 'snap'; state: TableState }
  | { t: 'ev'; ev: WsEvent; now: number }
  | { t: 'room'; room: Room }
  | { t: 'viewer'; id: string | null };

function reducer(s: TableState, a: Action): TableState {
  switch (a.t) {
    case 'snap':
      // Events that raced ahead of a slow snapshot for the same game win; take the newer room only.
      if (s.game && a.state.game && s.game.game_id === a.state.game.game_id && s.seq > a.state.seq) {
        return { ...s, room: a.state.room ?? s.room };
      }
      return { ...a.state, viewer: s.viewer };
    case 'ev':
      return applyEvent(s, a.ev, a.now);
    case 'room':
      return { ...s, room: a.room };
    case 'viewer':
      return { ...s, viewer: a.id };
  }
}

type AnyMove = Move | Move4;

function sortMoves(moves: AnyMove[]): AnyMove[] {
  const isBomb = (m: AnyMove) => m.pattern.type === 'bomb' || m.pattern.type === 'rocket';
  return [...moves].sort(
    (a, b) => Number(isBomb(a)) - Number(isBomb(b)) || a.pattern.main - b.pattern.main || a.cards.length - b.cards.length,
  );
}

export function RoomPage({ rid }: { rid: string }) {
  const guest = useGuest();
  const [state, dispatch] = useReducer(reducer, guest?.bot_id ?? null, emptyTable);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [load, setLoad] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [sockStatus, setSockStatus] = useState<SocketStatus>('connecting');
  const [busy, setBusy] = useState(false);
  /** Selected cards of own hand, as occurrence keys (ddz4 hands contain duplicate codes). */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const hintIdx = useRef(0);

  useEffect(() => {
    dispatch({ t: 'viewer', id: guest?.bot_id ?? null });
  }, [guest?.bot_id]);

  const mySeat = useMemo(() => {
    if (!guest || !state.room) return null;
    const i = state.room.seats.findIndex((s) => s?.bot_id === guest.bot_id);
    return i >= 0 ? i : null;
  }, [guest, state.room]);
  const playerMode = mySeat !== null && !!guest;
  const token = guest?.token ?? null;

  /** Fetches the room (and own hand when seated) and replaces the table state. */
  const refresh = useCallback(async () => {
    try {
      const { room, game } = await api.room(rid);
      let g = game;
      let own: OwnView | undefined;
      const me = guest ? room.seats.findIndex((s) => s?.bot_id === guest.bot_id) : -1;
      if (guest && game && me >= 0) {
        try {
          const pg = await api.gameState(guest.token, game.game_id);
          g = pg;
          const seat = pg.seat ?? me;
          if ('hand' in pg && Array.isArray(pg.hand)) own = { seat, hand: pg.hand };
          else if ('hole' in pg && Array.isArray(pg.hole)) own = { seat, hole: pg.hole, legal: pg.legal };
        } catch {
          /* not a player of this game (e.g. joined after it started) */
        }
      }
      dispatch({ t: 'snap', state: tableFromSnapshot(room, g, guest?.bot_id ?? null, Date.now(), own) });
      setLoad('ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setLoad('notfound');
      else {
        setLoad((l) => (l === 'ok' ? l : 'error'));
        setLoadError(errorText(e));
      }
    }
  }, [rid, guest]);

  // Snapshot first, then a socket with since=<snapshot seq>; on resync rebuild both.
  useEffect(() => {
    let alive = true;
    let sock: LiveSocket | null = null;
    const start = async () => {
      await refresh();
      if (!alive) return;
      const path = playerMode && token ? `/ws?token=${encodeURIComponent(token)}` : `/ws/spectate?room=${encodeURIComponent(rid)}`;
      sock = new LiveSocket({
        path,
        getSince: () => stateRef.current.seq || null,
        onEvent: (ev) => {
          if (ev.room_id && ev.room_id !== rid) return;
          dispatch({ t: 'ev', ev, now: Date.now() });
        },
        onHello: (_d, withSince) => {
          // Without a known seq we could have missed events between the GET and the connect.
          if (!withSince) void refresh();
        },
        onResync: () => {
          sock?.close();
          sock = null;
          if (alive) void start();
        },
        onStatus: (s) => alive && setSockStatus(s),
      });
    };
    void start();
    return () => {
      alive = false;
      sock?.close();
    };
  }, [rid, playerMode, token, refresh]);

  const isHoldem = state.gameType === 'holdem';
  const isDdz4 = state.gameType === 'ddz4';
  const g = state.game;
  const hg = state.holdem;
  const room = state.room;
  const myHand = mySeat !== null ? (g?.hands[mySeat] ?? null) : null;
  const myTurn = !!g && mySeat !== null && g.turn === mySeat && g.phase !== 'finished';
  const handKey = myHand?.join(',') ?? '';

  // Drop selected cards that left the hand; reset hint cycle on every new turn.
  useEffect(() => {
    setSelected((sel) => {
      const keys = new Set(cardKeys(myHand ?? []));
      const next = new Set([...sel].filter((k) => keys.has(k)));
      return next.size === sel.size ? sel : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handKey]);
  useEffect(() => {
    hintIdx.current = 0;
  }, [g?.turn_seq, g?.game_id]);
  // A new deal or a finished game clears the selection.
  useEffect(() => {
    setSelected((sel) => (sel.size ? new Set() : sel));
  }, [g?.game_id, g?.phase === 'finished']);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const join = (seat: number) =>
    run(async () => {
      const r = await api.join(token!, rid, seat);
      dispatch({ t: 'room', room: r.room });
    });
  const leave = () => {
    const inGame = isHoldem
      ? !!hg && hg.phase !== 'finished' && mySeat !== null && hg.stacks[mySeat] !== null && hg.stacks[mySeat] !== undefined
      : !!g && g.phase !== 'finished';
    if (inGame && !confirm('对局中离开，你的座位会托管到本局结束。确定离开？')) return;
    return run(async () => {
      await api.leave(token!, rid);
      await refresh();
    });
  };
  const setReady = (ready: boolean) =>
    run(async () => {
      const r = await api.ready(token!, rid, ready);
      dispatch({ t: 'room', room: r.room });
    });
  const seqArg = () => stateRef.current.seq || undefined;
  const bid = (score: number) => run(() => api.bid(token!, g!.game_id, score, seqArg()));
  const play = (cards: Card[]) =>
    run(async () => {
      await api.play(token!, g!.game_id, cards, seqArg());
      setSelected(new Set());
    });
  const act = (action: HoldemAction, amount?: number) => run(() => api.action(token!, hg!.game_id, action, amount, seqArg()));

  const toBeatEngine = useMemo(() => {
    const p = g?.to_beat?.pattern;
    if (!p) return null;
    const main = RANK_LABELS.indexOf(p.rank);
    return main >= 0 ? { type: p.type, main, length: p.length } : null;
  }, [g?.to_beat]);

  const hint = () => {
    if (!myHand) return;
    const lead = g?.can_pass ? toBeatEngine : null;
    const moves = sortMoves(
      isDdz4 ? legalMoves4(myHand, lead as Pattern4 | null) : legalMoves(myHand, lead as Move['pattern'] | null),
    );
    if (moves.length === 0) {
      toast('没有能压过上家的牌', 'info');
      setSelected(new Set());
      return;
    }
    const m = moves[hintIdx.current % moves.length]!;
    hintIdx.current++;
    setSelected(keysForCards(myHand, m.cards));
  };

  const toggle = (k: string) => {
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const selectedCards = myHand ? cardsByKeys(myHand, selected) : [];
  const preview = useMemo(() => {
    if (selectedCards.length === 0) return '';
    const p = isDdz4 ? preferred4(identify4(selectedCards)) : preferred(identify(selectedCards));
    return p ? patternName({ type: p.type, rank: RANK_LABELS[p.main]!, length: p.length }, state.gameType) : '不成牌型';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCards.join(','), isDdz4]);

  if (load === 'notfound') {
    return (
      <div className="page">
        <div className="error-box">
          房间 {rid} 不存在或已关闭。<a href={href.lobby()}>返回大厅</a>
        </div>
      </div>
    );
  }
  if (load === 'loading' || (load === 'error' && !room)) {
    return (
      <div className="page">
        {load === 'error' ? (
          <div className="error-box">
            加载失败：{loadError} <button className="btn btn-small" onClick={() => void refresh()}>重试</button>
          </div>
        ) : (
          <div className="muted">加载中…</div>
        )}
      </div>
    );
  }

  const mySeatInfo = mySeat !== null ? room?.seats[mySeat] : null;
  const gameRunning = isHoldem ? !!hg && hg.phase !== 'finished' : !!g && g.phase !== 'finished';
  const readyControls = (
    <div className="controls">
      {mySeatInfo?.ready ? (
        <button className="btn" disabled={busy} onClick={() => setReady(false)}>
          取消准备
        </button>
      ) : (
        <button className="btn btn-primary" disabled={busy} onClick={() => setReady(true)}>
          准备
        </button>
      )}
      <button className="btn" disabled={busy} onClick={leave}>
        离开
      </button>
    </div>
  );

  let controls = null;
  if (playerMode && isHoldem) {
    const inHand = !!hg && mySeat !== null && hg.stacks[mySeat] !== null && hg.stacks[mySeat] !== undefined;
    if (hg && inHand && gameRunning && hg.turn === mySeat && hg.legal) {
      controls = (
        <HoldemControls
          legal={hg.legal}
          stack={hg.stacks[mySeat!] ?? null}
          bet={hg.bets[mySeat!] ?? 0}
          busy={busy}
          turnKey={`${hg.game_id}-${hg.turn_seq}`}
          onAct={act}
        />
      );
    } else if (!gameRunning) {
      controls = readyControls;
    } else {
      controls = (
        <div className="controls controls-waiting">
          <span className="muted">{inHand ? (hg!.folded[mySeat!] ? '已弃牌，等待本手结束' : '等待其他玩家行动') : '本手进行中，你从下一手开始参加'}</span>
          <button className="btn btn-small" disabled={busy} onClick={leave}>
            离开
          </button>
        </div>
      );
    }
  } else if (playerMode) {
    if (myTurn && g!.phase === 'bidding') {
      controls = (
        <div className="controls">
          <button className="btn" disabled={busy} onClick={() => bid(0)}>
            不叫
          </button>
          {[1, 2, 3].map((n) => (
            <button key={n} className="btn btn-primary" disabled={busy || n <= g!.high_bid} onClick={() => bid(n)}>
              {n} 分
            </button>
          ))}
        </div>
      );
    } else if (myTurn && g!.phase === 'playing') {
      controls = (
        <div className="controls">
          <button className="btn" disabled={busy || !g!.can_pass} onClick={() => play([])}>
            不出
          </button>
          <button className="btn" disabled={busy} onClick={hint}>
            提示
          </button>
          <button className="btn btn-primary" disabled={busy || selectedCards.length === 0} onClick={() => play(selectedCards)}>
            出牌
          </button>
          {preview && <span className="preview">{preview}</span>}
        </div>
      );
    } else if (!gameRunning) {
      controls = readyControls;
    } else {
      controls = (
        <div className="controls controls-waiting">
          <span className="muted">{g!.phase === 'bidding' ? '等待其他玩家叫分' : '等待其他玩家出牌'}</span>
          {selectedCards.length > 0 && preview && <span className="preview">{preview}</span>}
          <button className="btn btn-small" disabled={busy} onClick={leave}>
            离开
          </button>
        </div>
      );
    }
  }

  const seatExtra = (seat: number) => {
    if (!room || room.seats[seat] || mySeat !== null || !guest) return null;
    return (
      <button className="btn btn-small btn-primary" disabled={busy} onClick={() => join(seat)}>
        入座
      </button>
    );
  };

  const filled = room ? room.seats.filter(Boolean).length : 0;
  const readyCount = room ? room.seats.filter((s) => s?.ready).length : 0;
  const seatTotal = isHoldem ? holdemSeats(state) : tableSeats(state);
  const idleText = isHoldem
    ? filled < 2
      ? `等待玩家入座（${filled}/${seatTotal}，至少 2 人）`
      : `等待准备（${readyCount}/${filled}）`
    : filled < seatTotal
      ? `等待玩家入座（${filled}/${seatTotal}）`
      : `等待准备（${readyCount}/${seatTotal}）`;
  const hasEmpty = room ? room.seats.some((s) => !s) : false;
  const finishedGid = isHoldem ? (hg?.phase === 'finished' ? hg.game_id : null) : g?.phase === 'finished' ? g.game_id : null;
  const resultFooter = finishedGid ? (
    <a className="btn btn-small" href={href.replay(finishedGid)}>
      查看回放
    </a>
  ) : null;

  return (
    <div className="page room-page">
      <div className="room-head">
        <a href={href.lobby()} className="back-link">
          ← 大厅
        </a>
        <h2>{room?.name ?? rid}</h2>
        <span className={`badge game-badge game-${state.gameType}`}>{GAME_LABELS[state.gameType]}</span>
        <span className={`status status-${room?.status}`}>{room?.status === 'playing' ? '对局中' : '等待中'}</span>
        <span className="muted">
          围观 {room?.spectators ?? 0} · 已打 {room?.games_played ?? 0} 局
        </span>
        <span className={`sock sock-${sockStatus}`} title={sockStatus === 'open' ? '实时连接正常' : '正在重连'}>
          {sockStatus === 'open' ? (playerMode ? '对局中' : '围观中') : '重连中…'}
        </span>
      </div>
      {!guest && hasEmpty && (
        <details className="join-help">
          <summary>想下场？选一个身份后可以入座</summary>
          <GuestForm compact />
        </details>
      )}
      <div className="room-body">
        {isHoldem ? (
          <HoldemTable
            state={state}
            viewSeat={mySeat ?? 0}
            reveal={false}
            showTimers
            mySeat={mySeat}
            seatExtra={seatExtra}
            controls={controls}
            idleText={idleText}
            resultFooter={resultFooter}
          />
        ) : (
        <Table
          state={state}
          viewSeat={mySeat ?? 0}
          reveal={false}
          showTimers
          mySeat={mySeat}
          selected={selected}
          onToggle={myTurn && g?.phase === 'playing' ? toggle : mySeat !== null ? toggle : undefined}
          seatExtra={seatExtra}
          controls={controls}
          idleText={idleText}
          resultFooter={resultFooter}
        />
        )}
        <aside className="room-side">
          <h3>{isHoldem ? '行动记录' : '出牌记录'}</h3>
          {isHoldem ? <HoldemHistory state={state} /> : <History state={state} />}
          <h3 className="room-games-title">本房间对局</h3>
          <GameList key={rid} limit={10} roomId={rid} />
        </aside>
      </div>
    </div>
  );
}
