import { useEffect, useMemo, useState } from 'react';
import { type Replay, ApiError, api, errorText } from '../api.ts';
import { History } from '../components/History.tsx';
import { Table } from '../components/Table.tsx';
import { href } from '../router.ts';
import { buildReplayStates } from '../state.ts';

const SPEEDS = [0.5, 1, 2, 4];

export function ReplayPage({ gid }: { gid: string }) {
  const [rep, setRep] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [god, setGod] = useState(true);
  const [viewSeat, setViewSeat] = useState(0);

  useEffect(() => {
    let alive = true;
    setRep(null);
    setError(null);
    api
      .replay(gid)
      .then((r) => {
        if (!alive) return;
        setRep(r);
        setStep(0);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setError('牌局不存在，或还没结束（回放仅对已结束的牌局开放）');
        else setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [gid]);

  const states = useMemo(() => (rep ? buildReplayStates(rep) : []), [rep]);
  const last = Math.max(0, states.length - 1);
  const cur = states[Math.min(step, last)];

  useEffect(() => {
    if (!playing) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(last, s + 1)), 900 / speed);
    return () => clearTimeout(t);
  }, [playing, step, last, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.key === 'ArrowRight') setStep((s) => Math.min(last, s + 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [last]);

  if (error) {
    return (
      <div className="page">
        <div className="error-box">
          {error} <a href={href.lobby()}>返回大厅</a>
        </div>
      </div>
    );
  }
  if (!rep || !cur) return <div className="page muted">加载回放…</div>;

  const finalState = states[last]!;
  return (
    <div className="page room-page">
      <div className="room-head">
        <a href={href.lobby()} className="back-link">
          ← 大厅
        </a>
        <h2>回放 {gid}</h2>
        {rep.room_id && (
          <a className="muted" href={href.room(rep.room_id)}>
            房间 {rep.room_id}
          </a>
        )}
        <span className="muted" title="随机种子">
          seed {rep.seed}
        </span>
      </div>
      <div className="replay-bar">
        <button className="btn btn-small" onClick={() => setStep(0)} disabled={step === 0} aria-label="回到开头">
          ⏮
        </button>
        <button className="btn btn-small" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          上一步
        </button>
        <button
          className="btn btn-small btn-primary"
          onClick={() => {
            if (step >= last) setStep(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? '暂停' : '播放'}
        </button>
        <button className="btn btn-small" onClick={() => setStep((s) => Math.min(last, s + 1))} disabled={step >= last}>
          下一步
        </button>
        <input
          className="timeline"
          type="range"
          min={0}
          max={last}
          value={Math.min(step, last)}
          onChange={(e) => {
            setStep(Number(e.target.value));
            setPlaying(false);
          }}
          aria-label="时间轴"
        />
        <span className="step-count">
          {Math.min(step, last)}/{last}
        </span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="播放速度">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={god} onChange={(e) => setGod(e.target.checked)} /> 上帝视角
        </label>
        <select value={viewSeat} onChange={(e) => setViewSeat(Number(e.target.value))} aria-label="底部座位">
          {[0, 1, 2].map((s) => (
            <option key={s} value={s}>
              底部：{finalState.game?.players.find((p) => p.seat === s)?.name ?? `座位 ${s}`}
            </option>
          ))}
        </select>
      </div>
      <div className="room-body">
        <Table state={cur} viewSeat={viewSeat} reveal={god} showTimers={false} />
        <aside className="room-side">
          <h3>出牌记录</h3>
          <History state={cur} />
        </aside>
      </div>
    </div>
  );
}
