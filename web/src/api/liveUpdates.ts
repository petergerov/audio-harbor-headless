import type { TokenStore } from './http';
import type { NowPlaying, QueueSnapshot, RackSnapshot, ScanProgress, SettingsSnapshot } from './types';

export type LiveMessage =
  | { type: 'nowPlaying'; payload: NowPlaying }
  | { type: 'queue'; payload: QueueSnapshot }
  | { type: 'settings'; payload: SettingsSnapshot }
  | { type: 'scan'; payload: ScanProgress }
  | { type: 'rack'; payload: RackSnapshot };

const RECONNECT_MS = 2000;

/** The host's push channel (WebSocket); reconnects after a drop. */
export class LiveUpdates {
  constructor(private readonly tokens: TokenStore) {}

  connect(onMessage: (message: LiveMessage) => void): void {
    // Without a code the host takes no token; with one, it is sent.
    const token = this.tokens.get();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws${query}`);
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
