import type { Store } from '../core/store';
import type { AppState } from '../state/appState';
import { durationSecs, isPlaying } from '../state/selectors';

const TICK_MS = 250;
/** pointerup and change both end a drag: the second, same seek is dropped. */
const SAME_SEEK_MS = 500;

/**
 * The play position between the host's snapshots: counted from the last position the host
 * reported (and when), so it stays exact however late the ticks come; it holds still while the user
 * drags a scrubber, and does no work while the page is hidden.
 */
export class PlaybackClock {
  position = 0;
  scrubbing = false;
  private readonly listeners = new Set<(position: number) => void>();
  private timer: number | undefined;
  private lastSeek = { seconds: -1, at: 0 };
  /** The position last set, and when (performance.now()). */
  private anchor = { position: 0, at: 0 };

  constructor(private readonly store: Store<AppState>) {
    store.subscribe((state, previous) => {
      const now = state.nowPlaying;
      const before = previous.nowPlaying;
      if (now === before || this.scrubbing) return;
      // A snapshot the remote made itself (play / pause flipped at once, a volume change) repeats
      // the last reported position: the clock goes on from where it is, it does not jump back.
      const reported = now?.positionSecs !== before?.positionSecs || now?.track?.id !== before?.track?.id;
      const position = reported ? Number(now?.positionSecs ?? 0) : this.positionIn(previous);
      this.set(position);
    });
  }

  start(): void {
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (this.scrubbing || document.hidden) return;
      const state = this.store.get();
      if (isPlaying(state)) this.emit(this.positionIn(state));
    }, TICK_MS);
  }

  /** Called with the position on every change outside a drag. */
  onChange(listener: (position: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginScrub(): void {
    this.scrubbing = true;
  }

  /** Ends a drag at `seconds`; false when it repeats the seek just made. */
  endScrub(seconds: number): boolean {
    this.scrubbing = false;
    const now = Date.now();
    if (seconds === this.lastSeek.seconds && now - this.lastSeek.at < SAME_SEEK_MS) return false;
    this.lastSeek = { seconds, at: now };
    this.set(seconds);
    return true;
  }

  /** Where playback is now, by `state`'s play state: running from the anchor, or held at it. */
  private positionIn(state: AppState): number {
    const running = isPlaying(state) ? (performance.now() - this.anchor.at) / 1000 : 0;
    const position = this.anchor.position + running;
    const duration = durationSecs(state);
    return duration > 0 ? Math.min(position, duration) : position;
  }

  private set(position: number): void {
    this.anchor = { position, at: performance.now() };
    this.emit(position);
  }

  private emit(position: number): void {
    this.position = position;
    for (const listener of this.listeners) listener(position);
  }
}
