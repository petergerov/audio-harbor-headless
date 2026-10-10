import type { PlaybackApi } from '../api/playbackApi';
import type { NowPlaying, PlayContext, QueueSnapshot, RepeatMode, TransportCommand } from '../api/types';
import type { Store } from '../core/store';
import type { AppState } from '../state/appState';

/** What the screens may ask of playback. */
export interface PlaybackActions {
  play(context: PlayContext): Promise<void>;
  transport(command: TransportCommand): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(level: number): Promise<void>;
  setShuffle(on: boolean): Promise<void>;
  setRepeat(mode: RepeatMode): Promise<void>;
  /** Jumps to a queue position; the track playing now pauses or resumes. */
  playQueueIndex(index: number): Promise<void>;
}

/** Playback on the host; every answer lands in the store as the new now-playing snapshot. */
export class PlaybackService implements PlaybackActions {
  constructor(
    private readonly api: PlaybackApi,
    private readonly store: Store<AppState>
  ) {}

  async refresh(): Promise<void> {
    const [nowPlaying, queue] = await Promise.all([this.api.nowPlaying(), this.api.queue()]);
    this.store.update({ nowPlaying, queue });
  }

  /** A snapshot pushed by the host. */
  receive(nowPlaying: NowPlaying): void {
    this.store.update({ nowPlaying });
  }

  /** The queue as the host pushes it. */
  receiveQueue(queue: QueueSnapshot): void {
    this.store.update({ queue });
  }

  async play(context: PlayContext): Promise<void> {
    await this.api.play(context);
    await this.refresh();
  }

  async transport(command: TransportCommand): Promise<void> {
    if (command === 'toggle') this.optimisticToggle();
    try {
      this.receive(await this.api.transport(command));
    } catch (err) {
      if (command === 'toggle') await this.refresh().catch(() => undefined);
      throw err;
    }
  }

  async seek(seconds: number): Promise<void> {
    this.receive(await this.api.seek(seconds));
  }

  async setVolume(level: number): Promise<void> {
    const current = this.store.get().nowPlaying;
    if (current) this.receive({ ...current, volume: level });
    this.receive(await this.api.setVolume(level));
  }

  async setShuffle(on: boolean): Promise<void> {
    const current = this.store.get().nowPlaying;
    if (current) this.receive({ ...current, shuffle: on });
    this.receive(await this.api.setShuffle(on));
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    const current = this.store.get().nowPlaying;
    if (current) this.receive({ ...current, repeat: mode });
    this.receive(await this.api.setRepeat(mode));
  }

  async playQueueIndex(index: number): Promise<void> {
    this.receive(await this.api.playQueueIndex(index));
  }

  /** Flip play ↔ pause in the store before the host answers (iOS remote does the same). */
  private optimisticToggle(): void {
    const current = this.store.get().nowPlaying;
    if (!current?.track) return;
    if (current.state !== 'playing' && current.state !== 'paused' && current.state !== 'loading') return;
    this.receive({
      ...current,
      state: current.state === 'playing' ? 'paused' : 'playing',
    });
  }
}
