import path from 'node:path';
import { rootUuid, type Catalogue } from '../library/catalogue.js';
import type { PlaybackService } from '../playback/service.js';
import type { DsdPcmLevel, HarborConfig, NetworkDsdMode, NetworkStreamQuality, OutputMode } from '../types.js';
import type { Sharing } from '../upnp/sharing.js';

/** How a network player is fed, as the Mac's three choices. */
export type NetworkChoice = 'wifiFriendly' | 'full' | 'dsd';

/** Swift RemoteOutputDeviceDTO. */
export interface RemoteOutputDevice {
  uid: string;
  name: string;
  kind: 'local' | 'network';
  supportsExclusive: boolean;
  supportsDoP: boolean;
}

/** Swift RemoteOutputSettingsDTO. `selectedUID` null = system default output. */
export interface RemoteOutputSettings {
  devices: RemoteOutputDevice[];
  selectedUID: string | null;
  selectedName: string | null;
  isNetworkSelected: boolean;
  isDeviceMissing: boolean;
  outputMode: OutputMode;
  effectiveOutputMode: OutputMode;
  canExclusive: boolean;
  canDoP: boolean;
  networkChoice: NetworkChoice;
  supportsNativeDSD: boolean;
  dsdPCMLevel: DsdPcmLevel;
}

export interface RemoteSharingSettings {
  enabled: boolean;
  statusText: string;
  blockedByLicense: boolean;
  activeStreams: number;
}

export interface RemoteDirectory {
  id: string;
  name: string;
  displayPath: string;
}

export interface RemoteAbout {
  appName: string;
  versionLabel: string;
  tagline: string;
  licenseHeadline: string;
  licenseDetail: string;
}

/** Swift SettingsSnapshot: the host's Settings for the remotes. */
export interface SettingsSnapshot {
  output: RemoteOutputSettings;
  sharing: RemoteSharingSettings;
  directories: RemoteDirectory[];
  isScanning: boolean;
  about: RemoteAbout;
}

export interface SettingsSources {
  playback: PlaybackService;
  catalogue: Catalogue;
  sharing: Sharing;
  getConfig: () => HarborConfig;
  /** Scans the library roots again (the catalogue reports while it runs). */
  rescan: () => Promise<unknown>;
  version: string;
}

const MODE_TITLES: Record<OutputMode, string> = { shared: 'Shared', exclusive: 'Exclusive', dop: 'DoP' };

/** Wi‑Fi stream → Wi‑Fi friendly; DSD auto or DoP → DSD; else Full (Swift `NetworkOutputChoice.from`). */
export function networkChoiceOf(stream: NetworkStreamQuality, dsd: NetworkDsdMode): NetworkChoice {
  if (stream === 'wifi') return 'wifiFriendly';
  return dsd === 'auto' || dsd === 'dop' ? 'dsd' : 'full';
}

/** The network stream and DSD mode a choice stands for. */
export function networkChoiceOutput(choice: NetworkChoice): { stream: NetworkStreamQuality; dsd: NetworkDsdMode } {
  if (choice === 'wifiFriendly') return { stream: 'wifi', dsd: 'pcm' };
  return choice === 'dsd' ? { stream: 'full', dsd: 'auto' } : { stream: 'full', dsd: 'pcm' };
}

function isNetworkChoice(value: unknown): value is NetworkChoice {
  return value === 'wifiFriendly' || value === 'full' || value === 'dsd';
}

function isOutputMode(value: unknown): value is OutputMode {
  return value === 'shared' || value === 'exclusive' || value === 'dop';
}

function isDsdPcmLevel(value: unknown): value is DsdPcmLevel {
  return value === 0 || value === 3 || value === 6;
}

/**
 * Builds the Settings snapshot, applies Swift `SettingsPatch` changes, and tells watchers when
 * the snapshot changed (output, sharing, directories, scanning).
 */
export class RemoteSettings {
  private readonly watchers = new Set<(snapshot: SettingsSnapshot) => void>();
  private last = '';
  private pending = false;

  constructor(private readonly sources: SettingsSources) {
    sources.playback.on('settings', () => this.changed());
    sources.catalogue.on('scanning', () => this.changed());
    sources.sharing.on('change', () => this.changed());
  }

  snapshot(): SettingsSnapshot {
    const { playback, catalogue, sharing, getConfig, version } = this.sources;
    const cfg = getConfig();
    const status = playback.outputStatus();
    const picked = status.selectedUid ? status.devices.find((d) => d.uid === status.selectedUid) : undefined;
    return {
      output: {
        devices: status.devices.map((d) => ({
          uid: d.uid,
          name: d.name,
          kind: d.kind,
          supportsExclusive: d.supportsExclusive,
          supportsDoP: d.supportsDop,
        })),
        selectedUID: status.selectedUid,
        selectedName: status.selectedUid ? status.selectedName : null,
        isNetworkSelected: status.selectedKind === 'network',
        isDeviceMissing: !status.selectedAvailable,
        outputMode: status.requestedMode,
        effectiveOutputMode: status.effectiveMode,
        canExclusive: picked?.supportsExclusive ?? false,
        canDoP: picked?.supportsDop ?? false,
        networkChoice: networkChoiceOf(status.networkStream, status.networkDsd),
        supportsNativeDSD: (playback.pickedNetworkFormats()?.nativeDsd.length ?? 0) > 0,
        dsdPCMLevel: status.dsdPcmLevel,
      },
      sharing: {
        enabled: sharing.enabled,
        statusText: sharing.statusText,
        blockedByLicense: false,
        activeStreams: sharing.activeStreams,
      },
      directories: cfg.library.roots.map((root) => ({
        id: rootUuid(root),
        name: path.basename(root) || root,
        displayPath: root,
      })),
      isScanning: catalogue.isScanning,
      about: {
        appName: 'Audio Harbor Headless',
        versionLabel: version,
        tagline: 'No desktop UI. Still hear the file.',
        licenseHeadline: 'No account needed',
        licenseDetail: 'This host plays without a trial, an unlock or an account.',
      },
    };
  }

  /** Applies one Swift `SettingsPatch` (`{ dsdPCMLevel: { value: 6 } }` …); an error message, or null. */
  async apply(patch: unknown): Promise<string | null> {
    if (!patch || typeof patch !== 'object') return 'Unknown setting';
    const body = patch as Record<string, unknown>;
    const key = Object.keys(body)[0];
    const arg = (body[key ?? ''] ?? {}) as Record<string, unknown>;
    const { playback, catalogue, sharing, getConfig, rescan } = this.sources;
    const cfg = getConfig();
    const status = playback.outputStatus();

    switch (key) {
      case 'outputDevice': {
        const cleaned = typeof arg.uid === 'string' ? arg.uid.trim() : '';
        const next = cleaned || null;
        // A remembered network pick may be off right now.
        if (next && !next.startsWith('upnp:') && !status.devices.some((d) => d.uid === next)) {
          return 'That output is not available';
        }
        await playback.setOutput(next, cfg.output.mode);
        return null;
      }
      case 'outputMode': {
        const mode = arg.value;
        if (!isOutputMode(mode)) return 'Unknown output mode';
        const picked = status.devices.find((d) => d.uid === status.selectedUid);
        const available = mode === 'exclusive' ? picked?.supportsExclusive : picked?.supportsDop;
        if (mode !== 'shared' && !available) return `${MODE_TITLES[mode]} needs a capable USB DAC`;
        await playback.setOutput(status.selectedUid, mode);
        return null;
      }
      case 'networkChoice': {
        const choice = arg.value;
        if (!isNetworkChoice(choice)) return 'Unknown network mode';
        if (choice === 'dsd' && !playback.pickedNetworkFormats()?.nativeDsd.length) {
          return 'This player does not list DSD';
        }
        if (status.selectedKind !== 'network') return 'Pick a network player first';
        const { stream, dsd } = networkChoiceOutput(choice);
        await playback.setOutput(status.selectedUid, cfg.output.mode, undefined, stream, dsd);
        return null;
      }
      case 'dsdPCMLevel': {
        const level = arg.value;
        if (!isDsdPcmLevel(level)) return 'Unknown DSD level';
        playback.setDsdPcmLevel(level);
        return null;
      }
      case 'sharingEnabled':
        if (typeof arg.value !== 'boolean') return 'Sharing needs on or off';
        await sharing.setEnabled(arg.value);
        return null;
      case 'rebuildIndex':
        if (catalogue.isScanning) return 'Catalogue is already rebuilding';
        if (!cfg.library.roots.length) return 'No directories connected';
        void rescan().catch((err) => console.warn('Rescan failed:', err));
        return null;
      default:
        return 'Unknown setting';
    }
  }

  /** Calls `onChange` with each new snapshot; returns the unsubscribe. */
  watch(onChange: (snapshot: SettingsSnapshot) => void): () => void {
    this.watchers.add(onChange);
    return () => this.watchers.delete(onChange);
  }

  /** Something the snapshot shows may have changed (e.g. a root removed). */
  changed(): void {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      if (!this.watchers.size) return;
      const snapshot = this.snapshot();
      const json = JSON.stringify(snapshot);
      if (json === this.last) return;
      this.last = json;
      for (const watcher of this.watchers) watcher(snapshot);
    });
  }
}
