import type { PlaybackApi } from '../api/playbackApi';
import type { NowPlaying, PlayContext, TransportCommand } from '../api/types';
import type { Store } from '../core/store';
import type { AppState } from '../state/appState';

/** What the screens may ask of playback. */
export interface PlaybackActions {
  play(context: PlayContext): Promise<void>;
  transport(command: TransportCommand): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(level: number): Promise<void>;
}

/** Playback on the host; every answer lands in the store as the new now-playing snapshot. */
export class PlaybackService implements PlaybackActions {
  constructor(
    private readonly api: PlaybackApi,
    private readonly store: Store<AppState>
  ) {}

  async refresh(): Promise<void> {
    this.receive(await this.api.nowPlaying());
  }

  /** A snapshot pushed by the host. */
  receive(nowPlaying: NowPlaying): void {
    this.store.update({ nowPlaying });
  }

  async play(context: PlayContext): Promise<void> {
    await this.api.play(context);
    await this.refresh();
  }

  async transport(command: TransportCommand): Promise<void> {
    this.receive(await this.api.transport(command));
  }

  async seek(seconds: number): Promise<void> {
    this.receive(await this.api.seek(seconds));
  }

  async setVolume(level: number): Promise<void> {
    this.receive(await this.api.setVolume(level));
  }
}
