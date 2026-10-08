import { EventEmitter } from 'node:events';
import {
  applyOutput,
  buildOutputStatus,
  engineGetState,
  engineLoad,
  enginePause,
  enginePlay,
  engineSeek,
  engineSetVolume,
  engineStop,
  engineEvents,
} from '../engine/bridge.js';
import type { Catalogue } from '../library/catalogue.js';
import type { DiscoveredRenderer } from '../upnp/rendererOutput.js';
import { pauseOnRenderer, playOnRenderer } from '../upnp/rendererOutput.js';
import type {
  HarborConfig,
  NowPlayingSnapshot,
  OutputDevice,
  OutputMode,
  QueueSnapshot,
  RepeatMode,
  Track,
} from '../types.js';

export class PlaybackService extends EventEmitter {
  private queue: Track[] = [];
  private index: number | null = null;
  private shuffle = false;
  private repeat: RepeatMode = 'off';
  private current: Track | null = null;
  private networkDevices: DiscoveredRenderer[] = [];

  constructor(
    private catalogue: Catalogue,
    private getConfig: () => HarborConfig,
    private saveConfig: (cfg: HarborConfig) => void
  ) {
    super();
    engineEvents.on('state', () => this.emitUpdate());
    engineEvents.on('ended', () => {
      void this.next();
    });
  }

  setNetworkDevices(devices: DiscoveredRenderer[]): void {
    this.networkDevices = devices;
    this.emitUpdate();
  }

  private isNetworkOutput(uid: string | null | undefined): boolean {
    return Boolean(uid && uid.startsWith('upnp:'));
  }

  private selectedRenderer(): DiscoveredRenderer | null {
    const uid = this.getConfig().output.device_uid ?? null;
    if (!uid) return null;
    return this.networkDevices.find((d) => d.uid === uid) ?? null;
  }

  snapshot(): NowPlayingSnapshot {
    const cfg = this.getConfig();
    const eng = engineGetState();
    const net = this.networkDevices as OutputDevice[];
    const output = buildOutputStatus(cfg.output.device_uid ?? null, cfg.output.mode, net);
    const network = this.isNetworkOutput(cfg.output.device_uid);
    return {
      state: network ? (this.current ? 'playing' : 'idle') : (eng?.state ?? 'idle'),
      track: this.current,
      positionSecs: eng?.positionSecs ?? 0,
      durationSecs: eng?.durationSecs ?? this.current?.durationSecs ?? null,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: eng?.volume ?? output.volume,
      output: network
        ? { ...output, effectiveMode: 'shared', conversionBadge: 'Network' }
        : output,
      conversionBadge: network ? 'Network' : (eng?.conversionBadge ?? output.conversionBadge),
    };
  }

  queueSnapshot(): QueueSnapshot {
    return { tracks: this.queue, currentIndex: this.index };
  }

  async playTrack(cataloguePath: string): Promise<void> {
    const track = this.catalogue.getTrack(cataloguePath);
    if (!track) throw new Error('Track not found');
    this.queue = [track];
    this.index = 0;
    await this.loadAndPlay(track);
  }

  async playTracks(tracks: Track[], startIndex = 0): Promise<void> {
    if (!tracks.length) return;
    this.queue = tracks;
    this.index = Math.min(Math.max(0, startIndex), tracks.length - 1);
    await this.loadAndPlay(tracks[this.index]!);
  }

  async transport(cmd: TransportCommand): Promise<void> {
    switch (cmd.type) {
      case 'play': {
        const r = this.selectedRenderer();
        if (r && this.current) await playOnRenderer(r, this.current.cataloguePath);
        else enginePlay();
        break;
      }
      case 'pause': {
        const r = this.selectedRenderer();
        if (r) await pauseOnRenderer(r);
        else enginePause();
        break;
      }
      case 'toggle': {
        const r = this.selectedRenderer();
        if (r && this.current) {
          await pauseOnRenderer(r);
        } else {
          const st = engineGetState()?.state;
          if (st === 'playing') enginePause();
          else enginePlay();
        }
        break;
      }
      case 'stop':
        engineStop();
        this.current = null;
        break;
      case 'next':
        await this.next();
        break;
      case 'previous':
        await this.previous();
        break;
      case 'seek':
        engineSeek(cmd.seconds);
        break;
      case 'setVolume':
        engineSetVolume(cmd.level);
        break;
      case 'setShuffle':
        this.shuffle = cmd.enabled;
        break;
      case 'setRepeat':
        this.repeat = cmd.mode;
        break;
    }
    this.emitUpdate();
  }

  setOutput(deviceUid: string | null, mode: OutputMode): void {
    const cfg = this.getConfig();
    cfg.output.device_uid = deviceUid;
    cfg.output.mode = mode;
    this.saveConfig(cfg);
    applyOutput(deviceUid, mode, cfg.output.dsd_pcm_level);
    this.emitUpdate();
  }

  applyConfigOutput(): void {
    const cfg = this.getConfig();
    applyOutput(cfg.output.device_uid ?? null, cfg.output.mode, cfg.output.dsd_pcm_level);
  }

  private async loadAndPlay(track: Track): Promise<void> {
    this.current = track;
    this.emitUpdate();
    const renderer = this.selectedRenderer();
    if (renderer) {
      engineStop();
      await playOnRenderer(renderer, track.cataloguePath);
      this.emitUpdate();
      return;
    }
    await engineLoad(track.cataloguePath);
    enginePlay();
    this.emitUpdate();
  }

  private async next(): Promise<void> {
    if (this.repeat === 'one' && this.current) {
      await this.loadAndPlay(this.current);
      return;
    }
    if (this.index == null || !this.queue.length) return;
    let next = this.index + 1;
    if (next >= this.queue.length) {
      if (this.repeat === 'all') next = 0;
      else {
        engineStop();
        this.current = null;
        this.emitUpdate();
        return;
      }
    }
    this.index = next;
    await this.loadAndPlay(this.queue[next]!);
  }

  private async previous(): Promise<void> {
    if (this.index == null || !this.queue.length) return;
    const eng = engineGetState();
    if ((eng?.positionSecs ?? 0) > 3) {
      engineSeek(0);
      this.emitUpdate();
      return;
    }
    const prev = Math.max(0, this.index - 1);
    this.index = prev;
    await this.loadAndPlay(this.queue[prev]!);
  }

  private emitUpdate(): void {
    this.emit('nowPlaying', this.snapshot());
    this.emit('queue', this.queueSnapshot());
  }
}

export type TransportCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'stop' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; seconds: number }
  | { type: 'setVolume'; level: number }
  | { type: 'setShuffle'; enabled: boolean }
  | { type: 'setRepeat'; mode: RepeatMode };
