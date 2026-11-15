import { useCallback, useEffect, useState } from 'react';
import { type GameSummary, type LeaderboardRow, type Room, api, errorText } from '../api.ts';
import { GuestForm } from '../components/Guest.tsx';
import { toast } from '../components/Toast.tsx';
import { useGuest } from '../guest.ts';
import { href, navigate } from '../router.ts';
import { fmtTime, pct } from '../util.ts';

function usePoll<T>(fn: () => Promise<T>, ms: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const d = await fn();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(errorText(e));
      }
      if (alive) timer = setTimeout(run, ms);
    };
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function Lobby({ tab }: { tab: string | null }) {
  const active = tab === 'leaderboard' ? 'leaderboard' : tab === 'games' ? 'games' : 'rooms';
  return (
    <div className="page lobby">
      <nav className="tabs">
        <a className={active === 'rooms' ? 'active' : ''} href={href.lobby()}>
          房间
        </a>
        <a className={active === 'games' ? 'active' : ''} href={href.lobby('games')}>
          最近对局
        </a>
        <a className={active === 'leaderboard' ? 'active' : ''} href={href.lobby('leaderboard')}>
          排行榜
        </a>
      </nav>
      {active === 'rooms' && (
        <div className="lobby-grid">
          <Rooms />
          <aside className="lobby-side">
            <h3>最近对局</h3>
            <Games limit={8} />
          </aside>
        </div>
      )}
      {active === 'games' && <Games limit={50} />}
      {active === 'leaderboard' && <Leaderboard />}
    </div>
  );
}

function Rooms() {
  const { data, error, reload } = usePoll(() => api.rooms(), 3000);
  const guest = useGuest();
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState('');

  const create = async () => {
    if (!guest) return;
    setCreating(true);
    try {
      const room = await api.createRoom(guest.token, roomName.trim() || undefined);
      reload();
      navigate(href.room(room.id));
    } catch (e) {
      toast(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  const rooms = data?.rooms ?? [];
  return (
    <section className="rooms">
      <div className="section-head">
        <h2>房间 {data && <span className="muted">({rooms.length})</span>}</h2>
        {guest ? (
          <div className="create-room">
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="房间名（可选）" maxLength={24} aria-label="房间名" />
            <button className="btn btn-primary" onClick={create} disabled={creating}>
              新建房间
            </button>
          </div>
        ) : (
          <details className="create-room-help">
            <summary>新建房间</summary>
            <p className="muted">新建房间需要身份，先创建一个游客身份：</p>
            <GuestForm compact />
          </details>
        )}
      </div>
      {error && <div className="error-box">加载失败：{error}</div>}
      {!data && !error && <div className="muted">加载中…</div>}
      {data && rooms.length === 0 && <div className="empty">还没有房间。bot 调用 quick-join 后会自动出现。</div>}
      <div className="room-list">
        {rooms.map((r) => (
          <RoomCard key={r.id} room={r} />
        ))}
      </div>
    </section>
  );
}

function RoomCard({ room }: { room: Room }) {
  return (
    <div className="room-card">
      <div className="room-card-head">
        <a className="room-name" href={href.room(room.id)}>
          {room.name}
        </a>
        <span className={`status status-${room.status}`}>{room.status === 'playing' ? '对局中' : room.status === 'waiting' ? '等待中' : room.status}</span>
      </div>
      <ul className="room-seats">
        {[0, 1, 2].map((i) => {
          const s = room.seats[i];
          return (
            <li key={i} className={s ? '' : 'muted'}>
              <span className="seat-no">{i}</span>
              {s ? (
                <>
                  <span className="seat-n" title={s.bot_id}>
                    {s.name}
                  </span>
                  <span className="badge">{s.kind === 'human' ? '真人' : 'Bot'}</span>
                  {room.status !== 'playing' && <span className={`badge ${s.ready ? 'badge-ok' : ''}`}>{s.ready ? '已准备' : '未准备'}</span>}
                  {s.trustee && <span className="badge badge-warn">托管</span>}
                  {!s.connected && <span className="badge badge-warn">离线</span>}
                  <span className="seat-score">{s.score}</span>
                </>
              ) : (
                <span>空位</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="room-card-foot">
        <span className="muted">
          围观 {room.spectators} · 已打 {room.games_played} 局
        </span>
        <a className="btn btn-small" href={href.room(room.id)}>
          围观
        </a>
      </div>
    </div>
  );
}

function Games({ limit }: { limit: number }) {
  const { data, error } = usePoll(() => api.games(limit), 10000);
  const games = data?.games ?? [];
  if (error) return <div className="error-box">加载失败：{error}</div>;
  if (!data) return <div className="muted">加载中…</div>;
  if (games.length === 0) return <div className="empty">暂无已结束的对局</div>;
  return (
    <ul className="game-list">
      {games.map((g) => (
        <GameRow key={g.game_id} g={g} />
      ))}
    </ul>
  );
}

function GameRow({ g }: { g: GameSummary }) {
  const r = g.result;
  const time = fmtTime(g.finished_at ?? g.ended_at ?? g.started_at ?? g.created_at);
  const names = (g.players ?? []).map((p, i) => {
    const seat = typeof p.seat === 'number' ? p.seat : i;
    const sc = r?.scores?.[seat];
    return (
      <span key={seat} className={`gp${g.landlord === seat || r?.landlord === seat ? ' gp-landlord' : ''}`}>
        {p.name}
        {sc !== undefined && <span className={`score ${sc > 0 ? 'pos' : sc < 0 ? 'neg' : ''}`}>{sc > 0 ? `+${sc}` : sc}</span>}
      </span>
    );
  });
  return (
    <li className="game-row">
      <a href={href.replay(g.game_id)}>
        <div className="game-row-top">
          <span className="game-id">{g.game_id}</span>
          {r && <span className="badge">{r.kind === 'nobid' ? '流局' : r.winner === 'landlord' ? '地主胜' : '农民胜'}</span>}
          {r?.spring && <span className="badge badge-warn">春天</span>}
          {r?.anti_spring && <span className="badge badge-warn">反春</span>}
          {time && <span className="muted game-time">{time}</span>}
        </div>
        {names.length > 0 && <div className="game-players">{names}</div>}
      </a>
    </li>
  );
}

function Leaderboard() {
  const { data, error } = usePoll(() => api.leaderboard(), 15000);
  const [sort, setSort] = useState<'score' | 'winrate' | 'games'>('score');
  if (error) return <div className="error-box">加载失败：{error}</div>;
  if (!data) return <div className="muted">加载中…</div>;
  const rows: LeaderboardRow[] = [...data.bots].sort((a, b) => {
    if (sort === 'games') return b.games - a.games;
    if (sort === 'winrate') return (b.games ? b.wins / b.games : 0) - (a.games ? a.wins / a.games : 0);
    return b.score - a.score;
  });
  if (rows.length === 0) return <div className="empty">暂无数据</div>;
  return (
    <div className="leaderboard">
      <div className="sort-bar">
        排序：
        {(
          [
            ['score', '总分'],
            ['winrate', '胜率'],
            ['games', '局数'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`btn btn-small${sort === k ? ' btn-primary' : ''}`} onClick={() => setSort(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="table-scroll">
        <table className="lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>名称</th>
              <th>局数</th>
              <th>胜率</th>
              <th>地主胜率</th>
              <th>总分</th>
              <th>场均</th>
              <th>超时次数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => (
              <tr key={b.bot_id}>
                <td>{i + 1}</td>
                <td title={b.bot_id}>
                  {b.name}
                  {b.kind === 'human' && <span className="badge">真人</span>}
                </td>
                <td>{b.games}</td>
                <td>{pct(b.wins, b.games)}</td>
                <td>
                  {pct(b.landlord_wins, b.landlord_games)} <span className="muted">({b.landlord_games})</span>
                </td>
                <td className={b.score > 0 ? 'pos' : b.score < 0 ? 'neg' : ''}>{b.score}</td>
                <td>{b.games ? (b.score / b.games).toFixed(2) : '-'}</td>
                <td>{b.timeouts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
