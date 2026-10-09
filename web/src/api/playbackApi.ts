import type { HttpClient } from './http';
import type { NowPlaying, PlayContext, TransportCommand } from './types';

export interface PlaybackApi {
  nowPlaying(): Promise<NowPlaying>;
  play(context: PlayContext): Promise<void>;
  transport(command: TransportCommand): Promise<NowPlaying>;
  seek(seconds: number): Promise<NowPlaying>;
  setVolume(level: number): Promise<NowPlaying>;
}

export class HttpPlaybackApi implements PlaybackApi {
  constructor(private readonly http: HttpClient) {}

  nowPlaying(): Promise<NowPlaying> {
    return this.http.get('/api/v1/now-playing');
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
}
