import type { Store } from '../core/store';
import type { AppState } from '../state/appState';
import { durationSecs, isPlaying } from '../state/selectors';

const TICK_MS = 250;
/** pointerup and change both end a drag: the second, same seek is dropped. */
const SAME_SEEK_MS = 500;

/**
 * The play position between the host's snapshots: it runs while playing, follows each snapshot,
 * and holds still while the user drags a scrubber.
 */
export class PlaybackClock {
  position = 0;
  scrubbing = false;
  private readonly listeners = new Set<(position: number) => void>();
  private timer: number | undefined;
  private lastSeek = { seconds: -1, at: 0 };

  constructor(private readonly store: Store<AppState>) {
    store.subscribe((state, previous) => {
      if (state.nowPlaying === previous.nowPlaying || this.scrubbing) return;
      this.set(Number(state.nowPlaying?.positionSecs ?? this.position));
    });
  }

  start(): void {
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      const state = this.store.get();
      if (!isPlaying(state) || this.scrubbing) return;
      const duration = durationSecs(state);
      this.set(duration > 0 ? Math.min(this.position + TICK_MS / 1000, duration) : this.position + TICK_MS / 1000);
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

  private set(position: number): void {
    this.position = position;
    for (const listener of this.listeners) listener(position);
  }
}
