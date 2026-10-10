import type { HttpClient } from './http';
import type { NowPlaying, PlayContext, QueueSnapshot, RepeatMode, TransportCommand } from './types';

export interface PlaybackApi {
  nowPlaying(): Promise<NowPlaying>;
  queue(): Promise<QueueSnapshot>;
  play(context: PlayContext): Promise<void>;
  transport(command: TransportCommand): Promise<NowPlaying>;
  seek(seconds: number): Promise<NowPlaying>;
  setVolume(level: number): Promise<NowPlaying>;
  setShuffle(enabled: boolean): Promise<NowPlaying>;
  setRepeat(mode: RepeatMode): Promise<NowPlaying>;
  /** Jumps to a queue position; the track playing now pauses or resumes. */
  playQueueIndex(index: number): Promise<NowPlaying>;
}

export class HttpPlaybackApi implements PlaybackApi {
  constructor(private readonly http: HttpClient) {}

  nowPlaying(): Promise<NowPlaying> {
    return this.http.get('/api/v1/now-playing');
  }

  queue(): Promise<QueueSnapshot> {
    return this.http.get('/api/v1/queue');
  }

  async play(context: PlayContext): Promise<void> {
    await this.http.post('/api/v1/play', context);
  }

  transport(command: TransportCommand): Promise<NowPlaying> {
    return this.http.post('/api/v1/transport', { command });
  }

  seek(seconds: number): Promise<NowPlaying> {
    return this.http.post('/api/v1/transport', { command: 'seek', seconds });
  }

  setVolume(level: number): Promise<NowPlaying> {
    return this.http.post('/api/v1/transport', { command: 'setVolume', level });
  }

  setShuffle(enabled: boolean): Promise<NowPlaying> {
    return this.http.post('/api/v1/transport', { command: 'setShuffle', enabled });
  }

  setRepeat(mode: RepeatMode): Promise<NowPlaying> {
    return this.http.post('/api/v1/transport', { command: 'setRepeat', mode });
  }

  playQueueIndex(index: number): Promise<NowPlaying> {
    return this.http.post('/api/v1/transport', { command: 'playQueueIndex', index });
  }
}
