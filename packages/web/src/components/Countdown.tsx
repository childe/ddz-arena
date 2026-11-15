import { useEffect, useState } from 'react';

interface Props {
  /** ms left at local time `at`. */
  remaining: number;
  at: number;
  /** Full turn length, for the ring fraction. */
  total: number;
  size?: number;
}

/** SVG countdown ring with seconds in the middle. */
export function CountdownRing({ remaining, at, total, size = 40 }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, remaining - (now - at));
  const frac = total > 0 ? Math.min(1, left / total) : 0;
  const r = size / 2 - 3;
  const circ = 2 * Math.PI * r;
  const urgent = left < 5000;
  return (
    <div className={`countdown${urgent ? ' urgent' : ''}`} style={{ width: size, height: size }} title="剩余时间">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="cd-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="cd-bar"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="cd-text">{Math.ceil(left / 1000)}</span>
    </div>
  );
}
