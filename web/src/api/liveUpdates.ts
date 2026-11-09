import type { TokenStore } from './http';
import type { NowPlaying, QueueSnapshot, RackSnapshot, ScanProgress, SettingsSnapshot } from './types';

export type LiveMessage =
  | { type: 'nowPlaying'; payload: NowPlaying }
  | { type: 'queue'; payload: QueueSnapshot }
  | { type: 'settings'; payload: SettingsSnapshot }
  | { type: 'scan'; payload: ScanProgress }
  | { type: 'rack'; payload: RackSnapshot };

/** Whether the push channel is up. */
export type LiveStatus = 'open' | 'connecting';

/** Waits between attempts after a drop: quick at first, then calmer. */
const RETRY_MS = [500, 1000, 2000, 3000, 5000];
/** Back from the background after this long: the socket may have died without a close (iOS). */
const STALE_AFTER_HIDDEN_MS = 3000;

/**
 * The host's push channel (WebSocket). The host sends every snapshot when a socket opens, so a
 * fresh connection is a full resync. It reconnects after a drop (backing off, not while the page
 * is hidden) and at once when the page comes back from the background or the network returns.
 */
export class LiveUpdates {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: number | undefined;
  private hiddenAt = 0;
  private onMessage: (message: LiveMessage) => void = () => {};
  private onStatus: (status: LiveStatus) => void = () => {};
  private listening = false;

  constructor(private readonly tokens: TokenStore) {}

  connect(onMessage: (message: LiveMessage) => void, onStatus: (status: LiveStatus) => void = () => {}): void {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.listen();
    this.reopen();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        return;
      }
      if (!this.isOpen() || Date.now() - this.hiddenAt > STALE_AFTER_HIDDEN_MS) this.reopen();
    });
    window.addEventListener('online', () => this.reopen());
    // Restored from the back-forward cache: its socket is gone.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) this.reopen();
    });
  }

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Drops the socket (dead or alive) and opens a new one now. */
  private reopen(): void {
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.attempts = 0;
    this.open();
  }

  private open(): void {
    window.clearTimeout(this.timer);
    this.onStatus('connecting');
    // Without a code the host takes no token; with one, it is sent.
    const token = this.tokens.get();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws${query}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.onStatus('open');
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      try {
        this.onMessage(JSON.parse(String(event.data)) as LiveMessage);
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced on purpose
      this.ws = null;
      this.onStatus('connecting');
      this.retry();
    };
  }

  private retry(): void {
    // Hidden: no attempts in the background; coming back reconnects.
    if (document.hidden) return;
    const delay = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)]!;
    this.attempts += 1;
    this.timer = window.setTimeout(() => this.open(), delay);
  }
}
