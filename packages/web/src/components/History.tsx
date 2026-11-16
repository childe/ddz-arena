import { useEffect, useRef } from 'react';
import { type LogEntry, type TableState, seatName } from '../state.ts';
import { Hand, patternName } from './Card.tsx';

/** Scrolling play-by-play log of the current game. */
export function History({ state, entries }: { state: TableState; entries?: LogEntry[] }) {
  const log = entries ?? state.game?.log ?? [];
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
                开局{e.first_bidder !== null ? `，${name(e.first_bidder)} 先叫` : ''}
              </div>
            );
          case 'bid':
            return (
              <div key={e.key} className="log-row">
                <b>{name(e.seat)}</b> {e.score === 0 ? '不叫' : `叫 ${e.score} 分`}
                {e.auto && <span className="muted">（超时）</span>}
              </div>
            );
          case 'landlord':
            return (
              <div key={e.key} className="log-row log-sys">
                <b>{name(e.seat)}</b> 成为地主（{e.high_bid} 分），底牌 <Hand cards={e.bottom} size="xs" spread={0.6} className="inline-hand" />
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
                    <span className="log-pattern">{patternName(e.pattern, state.gameType)}</span>
                    <Hand cards={e.cards} size="xs" spread={0.6} className="inline-hand" />
                  </>
                )}
                {e.auto && <span className="muted">（代出）</span>}
              </div>
            );
          case 'redeal':
            return (
              <div key={e.key} className="log-row log-sys">
                {state.gameType === 'ddz4' ? '四家' : '三家'}都不叫，重新发牌（第 {e.count} 次）
              </div>
            );
          case 'finish':
            return (
              <div key={e.key} className="log-row log-sys">
                {e.result.kind === 'nobid'
                  ? '流局'
                  : `${e.result.winner === 'landlord' ? '地主' : '农民'}胜${e.result.spring ? '（春天）' : ''}${e.result.anti_spring ? '（反春）' : ''}，得分 ${e.result.scores.join(' / ')}`}
              </div>
            );
        }
      })}
    </div>
  );
}
