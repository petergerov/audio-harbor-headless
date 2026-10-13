import type { HttpClient } from './http';
import type {
  DriveList,
  FolderListing,
  Mount,
  ScanProgress,
  NetworkPlayerFormats,
  OutputChange,
  OutputStatus,
  SettingsPatch,
  SettingsSnapshot,
} from './types';

export interface SettingsApi {
  /** Output, sharing, directories and about, as the iOS app gets them. */
  settings(): Promise<SettingsSnapshot>;
  /** One change; answers with the snapshot after it. */
  applySettings(patch: SettingsPatch): Promise<SettingsSnapshot>;
  mounts(): Promise<Mount[]>;
  addMount(path: string): Promise<void>;
  removeMount(path: string): Promise<void>;
  /** Starts a scan (or joins the running one); answers at once with its progress. */
  rescan(): Promise<ScanProgress>;
  scanProgress(): Promise<ScanProgress>;
  /** Folders inside `path`, or the places to start from without it. */
  folders(path?: string): Promise<FolderListing>;
  drives(): Promise<DriveList>;
  /** Adds the drive to /etc/fstab and mounts it; answers with the mount point. */
  setUpDrive(uuid: string, name: string): Promise<string>;
  ejectDrive(name: string): Promise<void>;
  removeDrive(name: string): Promise<void>;
  /** The host's current PIN, to pair another device. */
  pairingPin(): Promise<string>;
  /** A fresh PIN; the old one stops working. */
  newPairingPin(): Promise<string>;
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

  rescan(): Promise<ScanProgress> {
    return this.http.post('/api/v1/library/rescan');
  }

  scanProgress(): Promise<ScanProgress> {
    return this.http.get('/api/v1/library/scan');
  }

  folders(path?: string): Promise<FolderListing> {
    return this.http.get(path ? `/api/v1/folders?path=${encodeURIComponent(path)}` : '/api/v1/folders');
  }

  drives(): Promise<DriveList> {
    return this.http.get('/api/v1/drives');
  }

  async setUpDrive(uuid: string, name: string): Promise<string> {
    const { mountPoint } = await this.http.post<{ mountPoint: string }>('/api/v1/drives', { uuid, name });
    return mountPoint;
  }

  async ejectDrive(name: string): Promise<void> {
    await this.http.post('/api/v1/drives/eject', { name });
  }

  async removeDrive(name: string): Promise<void> {
    await this.http.delete('/api/v1/drives', { name });
  }

  async pairingPin(): Promise<string> {
    return (await this.http.get<{ pin: string }>('/api/v1/remotes/pin')).pin;
  }

  async newPairingPin(): Promise<string> {
    return (await this.http.post<{ pin: string }>('/api/v1/remotes/pin')).pin;
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
