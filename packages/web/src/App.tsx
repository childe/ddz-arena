import { GuestBadge } from './components/Guest.tsx';
import { Toaster } from './components/Toast.tsx';
import { DocsPage } from './pages/DocsPage.tsx';
import { Lobby } from './pages/Lobby.tsx';
import { ReplayPage } from './pages/ReplayPage.tsx';
import { RoomPage } from './pages/RoomPage.tsx';
import { href, useRoute } from './router.ts';

export function App() {
  const route = useRoute();
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.lobby()}>
          <span className="brand-mark">♠</span> 斗地主 Bot 竞技场
        </a>
        <nav className="topnav">
          <a href={href.lobby()} className={route.page === 'lobby' && route.tab !== 'leaderboard' ? 'active' : ''}>
            大厅
          </a>
          <a href={href.lobby('leaderboard')} className={route.page === 'lobby' && route.tab === 'leaderboard' ? 'active' : ''}>
            排行榜
          </a>
          <a href={href.docs()} className={route.page === 'docs' ? 'active' : ''}>
            接口文档
          </a>
        </nav>
        <GuestBadge />
      </header>
      <main>
        {route.page === 'lobby' && <Lobby tab={route.tab} />}
        {route.page === 'room' && <RoomPage key={route.rid} rid={route.rid} />}
        {route.page === 'replay' && <ReplayPage key={route.gid} gid={route.gid} />}
        {route.page === 'docs' && <DocsPage />}
        {route.page === 'notfound' && (
          <div className="page">
            页面不存在：{route.path}。<a href={href.lobby()}>返回大厅</a>
          </div>
        )}
      </main>
      <Toaster />
    </div>
  );
}
