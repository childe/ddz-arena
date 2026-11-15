// WebSocket client with reconnect + backoff and `since=<last seq>` catch-up.
import type { WsEvent } from './api.ts';

export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface SocketOptions {
  /** Path + query without `since`, e.g. `/ws/spectate?room=r_1` or `/ws?token=...`. */
  path: string;
  /** Latest applied seq, or null if unknown (then `since` is omitted). */
  getSince: () => number | null;
  onEvent: (ev: WsEvent) => void;
  /** Called for every `hello`; `withSince` tells whether this connection asked for catch-up. */
  onHello?: (data: any, withSince: boolean) => void;
  onResync?: () => void;
  onStatus?: (s: SocketStatus) => void;
}

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

export class LiveSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private opts: SocketOptions;

  constructor(opts: SocketOptions) {
    this.opts = opts;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    const since = this.opts.getSince();
    const withSince = since !== null && since > 0;
    const sep = this.opts.path.includes('?') ? '&' : '?';
    const url = wsUrl(this.opts.path + (withSince ? `${sep}since=${since}` : ''));
    this.opts.onStatus?.('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.('open');
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 25000);
    };
    ws.onmessage = (m) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof m.data === 'string' ? m.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'pong' || msg.type === 'reply') return;
      if (msg.type === 'hello') return this.opts.onHello?.(msg.data ?? msg, withSince);
      if (msg.type === 'resync') return this.opts.onResync?.();
      this.opts.onEvent(msg as WsEvent);
    };
    ws.onclose = () => {
      this.cleanupTimers();
      this.ws = null;
      this.opts.onStatus?.('closed');
      this.scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private cleanupTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const delay = Math.min(15000, 500 * 2 ** this.attempt) + Math.random() * 300;
    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.cleanupTimers();
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}
