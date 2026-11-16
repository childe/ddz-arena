import { useCallback, useEffect, useState } from 'react';
import {
  type GameResult,
  type GameSummary,
  type GameType,
  type HoldemResult,
  type LeaderboardRow,
  type Room,
  type RoomConfig,
  GAME_LABELS,
  GAME_TYPES,
  api,
  errorText,
  gameTypeOf,
} from '../api.ts';
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
      {active === 'games' && <Games limit={50} filterable />}
      {active === 'leaderboard' && <Leaderboard />}
    </div>
  );
}

function Rooms() {
  const { data, error, reload } = usePoll(() => api.rooms(), 3000);
  const guest = useGuest();
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [game, setGame] = useState<GameType>('ddz');
  const [seats, setSeats] = useState(6);
  const [noLegal, setNoLegal] = useState(false);
  // Timeouts in seconds; empty = server default.
  const [bidSec, setBidSec] = useState('');
  const [playSec, setPlaySec] = useState('');
  const [actionSec, setActionSec] = useState('');

  const create = async () => {
    if (!guest) return;
    const config: Partial<RoomConfig> = {};
    if (game === 'holdem') config.seats = seats;
    if (noLegal) config.legal_moves_api = false;
    const sec = (v: string, label: string): number | undefined => {
      if (!v.trim()) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 120) throw new Error(`${label}必须是 1–120 秒`);
      return Math.round(n * 1000);
    };
    setCreating(true);
    try {
      if (game === 'holdem') {
        const a = sec(actionSec, '行动时限');
        if (a !== undefined) config.action_timeout_ms = a;
      } else {
        const b = sec(bidSec, '叫分时限');
        const p = sec(playSec, '出牌时限');
        if (b !== undefined) config.bid_timeout_ms = b;
        if (p !== undefined) config.play_timeout_ms = p;
      }
      const room = await api.createRoom(guest.token, { name: roomName.trim() || undefined, game, config });
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
          <div className="create-room-box">
            <div className="create-room">
              <select value={game} onChange={(e) => setGame(e.target.value as GameType)} aria-label="游戏类型">
                {GAME_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {GAME_LABELS[t]}
                  </option>
                ))}
              </select>
              {game === 'holdem' && (
                <select value={seats} onChange={(e) => setSeats(Number(e.target.value))} aria-label="座位数">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <option key={n} value={n}>
                      {n} 人桌
                    </option>
                  ))}
                </select>
              )}
              <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="房间名（可选）" maxLength={24} aria-label="房间名" />
              <button className="btn btn-primary" onClick={create} disabled={creating}>
                新建房间
              </button>
            </div>
            <details className="create-advanced">
              <summary>高级选项</summary>
              <div className="create-advanced-body">
                <label className="toggle">
                  <input type="checkbox" checked={noLegal} onChange={(e) => setNoLegal(e.target.checked)} /> 关闭 legal-moves 接口
                </label>
                {game === 'holdem' ? (
                  <label>
                    行动时限
                    <input type="number" min={1} max={120} value={actionSec} onChange={(e) => setActionSec(e.target.value)} placeholder="15" /> 秒
                  </label>
                ) : (
                  <>
                    <label>
                      叫分时限
                      <input type="number" min={1} max={120} value={bidSec} onChange={(e) => setBidSec(e.target.value)} placeholder="10" /> 秒
                    </label>
                    <label>
                      出牌时限
                      <input type="number" min={1} max={120} value={playSec} onChange={(e) => setPlaySec(e.target.value)} placeholder="20" /> 秒
                    </label>
                  </>
                )}
              </div>
            </details>
          </div>
        ) : (
          <details className="create-room-help">
            <summary>新建房间</summary>
            <p className="muted">新建房间需要身份：切回用过的身份、创建游客身份，或用 token 登录。</p>
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

function GameBadge({ game }: { game: unknown }) {
  const t = gameTypeOf(game);
  return <span className={`badge game-badge game-${t}`}>{GAME_LABELS[t]}</span>;
}

function RoomCard({ room }: { room: Room }) {
  return (
    <div className="room-card">
      <div className="room-card-head">
        <a className="room-name" href={href.room(room.id)}>
          {room.name}
        </a>
        <GameBadge game={room.game} />
        <span className={`status status-${room.status}`}>{room.status === 'playing' ? '对局中' : room.status === 'waiting' ? '等待中' : room.status}</span>
      </div>
      <ul className="room-seats">
        {room.seats.map((s, i) => {
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

function Games({ limit, filterable }: { limit: number; filterable?: boolean }) {
  const [game, setGame] = useState<GameType | ''>('');
  return (
    <>
      {filterable && (
        <div className="sort-bar">
          <select value={game} onChange={(e) => setGame(e.target.value as GameType | '')} aria-label="游戏类型">
            <option value="">全部游戏</option>
            {GAME_TYPES.map((t) => (
              <option key={t} value={t}>
                {GAME_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      )}
      <GameList key={game} limit={limit} game={game || undefined} />
    </>
  );
}

export function GameList({ limit, game, roomId }: { limit: number; game?: GameType; roomId?: string }) {
  const { data, error } = usePoll(() => api.games(limit, { game, roomId }), 10000);
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
  const type = gameTypeOf(g.game);
  const holdem = type === 'holdem';
  const dr = !holdem ? ((g.result ?? null) as GameResult | null) : null;
  const hr = holdem ? ((g.result ?? null) as HoldemResult | null) : null;
  const time = fmtTime(g.finished_at ?? g.ended_at ?? g.started_at ?? g.created_at);
  const names = (g.players ?? []).map((p, i) => {
    const seat = typeof p.seat === 'number' ? p.seat : i;
    const sc = g.result?.scores?.[seat];
    const landlord = !holdem && (g.landlord === seat || dr?.landlord === seat);
    const winner = !!hr?.winners?.includes(seat);
    return (
      <span key={seat} className={`gp${landlord ? ' gp-landlord' : ''}${winner ? ' gp-winner' : ''}`}>
        {p.name}
        {sc !== undefined && sc !== null && <span className={`score ${sc > 0 ? 'pos' : sc < 0 ? 'neg' : ''}`}>{sc > 0 ? `+${sc}` : sc}</span>}
      </span>
    );
  });
  return (
    <li className="game-row">
      <a href={href.replay(g.game_id)} title="查看回放">
        <div className="game-row-top">
          <GameBadge game={g.game} />
          <span className="game-id">{g.game_id}</span>
          {dr && <span className="badge">{dr.kind === 'nobid' ? '流局' : dr.winner === 'landlord' ? '地主胜' : '农民胜'}</span>}
          {dr?.spring && <span className="badge badge-warn">春天</span>}
          {dr?.anti_spring && <span className="badge badge-warn">反春</span>}
          {hr && <span className="badge">底池 {hr.pot}{hr.showdown ? ' · 摊牌' : ''}</span>}
          {time && <span className="muted game-time">{time}</span>}
        </div>
        {names.length > 0 && <div className="game-players">{names}</div>}
      </a>
    </li>
  );
}

function Leaderboard() {
  const [game, setGame] = useState<GameType>('ddz');
  return <LeaderboardTable key={game} game={game} setGame={setGame} />;
}

function LeaderboardTable({ game, setGame }: { game: GameType; setGame: (g: GameType) => void }) {
  const { data, error } = usePoll(() => api.leaderboard(game), 15000);
  const [sort, setSort] = useState<'score' | 'winrate' | 'games'>('score');
  const holdem = game === 'holdem';
  const picker = (
    <select value={game} onChange={(e) => setGame(e.target.value as GameType)} aria-label="游戏类型">
      {GAME_TYPES.map((t) => (
        <option key={t} value={t}>
          {GAME_LABELS[t]}
        </option>
      ))}
    </select>
  );
  if (error)
    return (
      <div className="leaderboard">
        <div className="sort-bar">{picker}</div>
        <div className="error-box">加载失败：{error}</div>
      </div>
    );
  if (!data) return <div className="muted">加载中…</div>;
  const rows: LeaderboardRow[] = [...data.bots].sort((a, b) => {
    if (sort === 'games') return b.games - a.games;
    if (sort === 'winrate') return (b.games ? b.wins / b.games : 0) - (a.games ? a.wins / a.games : 0);
    return b.score - a.score;
  });
  return (
    <div className="leaderboard">
      <div className="sort-bar">
        {picker}
        <span className="sort-label">排序：</span>
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
      {rows.length === 0 ? (
        <div className="empty">暂无数据</div>
      ) : (
      <div className="table-scroll">
        <table className="lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>名称</th>
              <th>{holdem ? '手数' : '局数'}</th>
              <th>胜率</th>
              {!holdem && <th>地主胜率</th>}
              <th>{holdem ? '累计筹码' : '总分'}</th>
              <th>{holdem ? '每手' : '场均'}</th>
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
                {!holdem && (
                  <td>
                    {pct(b.landlord_wins, b.landlord_games)} <span className="muted">({b.landlord_games})</span>
                  </td>
                )}
                <td className={b.score > 0 ? 'pos' : b.score < 0 ? 'neg' : ''}>{b.score}</td>
                <td>{b.games ? (b.score / b.games).toFixed(2) : '-'}</td>
                <td>{b.timeouts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {holdem && <p className="muted lb-note">德州扑克：胜率按赢到筹码的手数计算，累计筹码是每手净输赢之和。</p>}
    </div>
  );
}
