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

/** At least this long between two volume requests while a slider moves. */
const VOLUME_GAP_MS = 60;
/** After the last volume request, snapshots still carrying an older level are corrected this long. */
const VOLUME_HOLD_MS = 700;

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Playback on the host; every answer lands in the store as the new now-playing snapshot. */
export class PlaybackService implements PlaybackActions {
  /** The level the slider asks for, not yet sent. */
  private volumeWanted: number | null = null;
  /** The level last asked for, and until when snapshots defer to it. */
  private volumeLocal = 0;
  private volumeHoldUntil = 0;
  private volumeSending: Promise<void> | null = null;

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
    // While the slider moves, answers to older requests do not pull it back.
    if (nowPlaying.volume != null && (this.volumeSending || Date.now() < this.volumeHoldUntil)) {
      nowPlaying = { ...nowPlaying, volume: this.volumeLocal };
    }
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

  /**
   * Moves at once on screen; the host gets one request at a time, always the latest level — a
   * swipe over the slider is a handful of requests, not one per pixel.
   */
  setVolume(level: number): Promise<void> {
    this.volumeLocal = level;
    this.volumeWanted = level;
    const current = this.store.get().nowPlaying;
    if (current) this.store.update({ nowPlaying: { ...current, volume: level } });
    // Already sending: the loop picks this level up. Only the call that started it reports a failure.
    if (this.volumeSending) return Promise.resolve();
    this.volumeSending = this.sendVolume().finally(() => {
      this.volumeSending = null;
    });
    return this.volumeSending;
  }

  private async sendVolume(): Promise<void> {
    while (this.volumeWanted !== null) {
      const level = this.volumeWanted;
      this.volumeWanted = null;
      this.volumeHoldUntil = Date.now() + VOLUME_HOLD_MS;
      const snapshot = await this.api.setVolume(level);
      this.volumeHoldUntil = Date.now() + VOLUME_HOLD_MS;
      // The newest request answers for the slider; older answers only refresh the rest.
      this.receive(snapshot);
      if (this.volumeWanted !== null) await pause(VOLUME_GAP_MS);
    }
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
