import type { TokenStore } from './http';
import type { NowPlaying, QueueSnapshot, SettingsSnapshot } from './types';

export type LiveMessage =
  | { type: 'nowPlaying'; payload: NowPlaying }
  | { type: 'queue'; payload: QueueSnapshot }
  | { type: 'settings'; payload: SettingsSnapshot };

const RECONNECT_MS = 2000;

/** The host's push channel (WebSocket); reconnects after a drop. */
export class LiveUpdates {
  constructor(private readonly tokens: TokenStore) {}

  connect(onMessage: (message: LiveMessage) => void): void {
    const token = this.tokens.get();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(String(event.data)) as LiveMessage);
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      setTimeout(() => this.connect(onMessage), RECONNECT_MS);
    };
  }
}
