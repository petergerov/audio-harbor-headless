import type { HttpClient } from './http';
import type { Mount, NetworkPlayerFormats, OutputChange, OutputStatus, SettingsPatch, SettingsSnapshot } from './types';

export interface SettingsApi {
  /** Output, sharing, directories and about, as the iOS app gets them. */
  settings(): Promise<SettingsSnapshot>;
  /** One change; answers with the snapshot after it. */
  applySettings(patch: SettingsPatch): Promise<SettingsSnapshot>;
  mounts(): Promise<Mount[]>;
  addMount(path: string): Promise<void>;
  removeMount(path: string): Promise<void>;
  rescan(): Promise<void>;
  output(): Promise<OutputStatus>;
  /** Asks the host to search for network players now, and returns the output as it is. */
  discoverOutput(): Promise<OutputStatus>;
  /** What a network player lists (DSD types), its volume and its DSD mode. */
  networkFormats(uid: string): Promise<NetworkPlayerFormats>;
  setOutput(change: OutputChange): Promise<void>;
}

export class HttpSettingsApi implements SettingsApi {
  constructor(private readonly http: HttpClient) {}

  settings(): Promise<SettingsSnapshot> {
    return this.http.get('/api/v1/settings');
  }

  applySettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
    return this.http.put('/api/v1/settings', patch);
  }

  mounts(): Promise<Mount[]> {
    return this.http.get('/api/v1/mounts');
  }

  async addMount(path: string): Promise<void> {
    await this.http.post('/api/v1/mounts', { path });
  }

  async removeMount(path: string): Promise<void> {
    await this.http.delete('/api/v1/mounts', { path });
  }

  async rescan(): Promise<void> {
    await this.http.post('/api/v1/library/rescan');
  }

  output(): Promise<OutputStatus> {
    return this.http.get('/api/v1/output');
  }

  discoverOutput(): Promise<OutputStatus> {
    return this.http.post('/api/v1/output/discover');
  }

  networkFormats(uid: string): Promise<NetworkPlayerFormats> {
    return this.http.get(`/api/v1/output/formats?uid=${encodeURIComponent(uid)}`);
  }

  async setOutput(change: OutputChange): Promise<void> {
    await this.http.put('/api/v1/output', change);
  }
}
