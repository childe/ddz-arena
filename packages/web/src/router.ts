// Tiny hash router: #/, #/room/:rid, #/replay/:gid, #/docs
import { useEffect, useState } from 'react';

export type Route =
  | { page: 'lobby'; tab: string | null }
  | { page: 'room'; rid: string }
  | { page: 'replay'; gid: string }
  | { page: 'docs' }
  | { page: 'notfound'; path: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  const [p, query = ''] = path.split('?') as [string, string?];
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { page: 'lobby', tab: new URLSearchParams(query).get('tab') };
  if (parts[0] === 'room' && parts[1]) return { page: 'room', rid: parts[1] };
  if (parts[0] === 'replay' && parts[1]) return { page: 'replay', gid: parts[1] };
  if (parts[0] === 'docs') return { page: 'docs' };
  return { page: 'notfound', path };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const href = {
  lobby: (tab?: string) => (tab ? `#/?tab=${tab}` : '#/'),
  room: (rid: string) => `#/room/${encodeURIComponent(rid)}`,
  replay: (gid: string) => `#/replay/${encodeURIComponent(gid)}`,
  docs: () => '#/docs',
};

export function navigate(to: string): void {
  location.hash = to.replace(/^#/, '');
}
