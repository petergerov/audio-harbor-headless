import type { HttpClient } from './http';

export interface RecordingSettings {
  enabled: boolean;
  device: string;
  rate: number;
  folder: string;
  split: 'none' | 'silence';
  silence_db: number;
  silence_seconds: number;
  keep_raw: boolean;
}

export interface RecordingLive {
  rate: number;
  deviceBits: number;
  seconds: number;
  overruns: number;
  dropped: number;
  signal: boolean;
  content: 'pcm' | 'dop' | 'bitstream';
  bits: number;
  silent: boolean;
  peaks: number[];
  error: string | null;
}

export interface RecordingFile {
  name: string;
  kind: 'flac' | 'dsf' | 'spdif' | 'wav';
  sampleRate: number;
  bits: number;
  seconds: number;
}

export interface RecordingTake {
  name: string;
  dir: string;
  files: RecordingFile[];
  seconds: number;
  overruns: number;
  dropped: number;
  bitPerfect: boolean;
  error: string | null;
}

export interface RecordingSnapshot {
  available: boolean;
  inputAccess: 'granted' | 'undetermined' | 'denied';
  settings: RecordingSettings;
  folder: string;
  rates: number[];
  state: 'idle' | 'recording' | 'finalizing';
  live: RecordingLive | null;
  take: { name: string; startedAt: number; device: string; rate: number } | null;
  progress: number | null;
  last: RecordingTake | null;
  freeBytes: number | null;
}

export interface RecordingInput {
  id: string;
  name: string;
}

/** Recording from the host's digital input. */
export interface RecordingApi {
  snapshot(): Promise<RecordingSnapshot>;
  inputs(): Promise<RecordingInput[]>;
  start(opts?: { device?: string; rate?: number; split?: 'none' | 'silence' }): Promise<RecordingSnapshot>;
  stop(discard?: boolean): Promise<RecordingSnapshot>;
  updateSettings(patch: Partial<RecordingSettings>): Promise<RecordingSnapshot>;
}

export class HttpRecordingApi implements RecordingApi {
  constructor(private readonly http: HttpClient) {}

  snapshot(): Promise<RecordingSnapshot> {
    return this.http.get('/api/v1/recording');
  }

  async inputs(): Promise<RecordingInput[]> {
    return (await this.http.get<{ inputs: RecordingInput[] }>('/api/v1/recording/inputs')).inputs;
  }

  start(opts: { device?: string; rate?: number; split?: 'none' | 'silence' } = {}): Promise<RecordingSnapshot> {
    return this.http.post('/api/v1/recording/start', opts);
  }

  stop(discard = false): Promise<RecordingSnapshot> {
    return this.http.post('/api/v1/recording/stop', { discard });
  }

  updateSettings(patch: Partial<RecordingSettings>): Promise<RecordingSnapshot> {
    return this.http.put('/api/v1/recording/settings', patch);
  }
}
