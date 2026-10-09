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
import {
  listSacdTracks,
  parseSacdPath,
  prefetchSacdNeighbors,
  resolveSacdPlaybackPath,
  SACD_MARKER,
} from '../library/sacd.js';
import { isDsdTrack, nativeDsdContainers, sinkDsdTypes } from '../upnp/networkMedia.js';
import { LoadSuperseded, type NetworkPlayer } from '../upnp/networkPlayer.js';
import {
  isNetworkUid,
  rendererUid,
  sameRendererUid,
  type RendererBrowser,
  type UpnpRenderer,
} from '../upnp/ssdp.js';
import type {
  AudioBackend,
  HarborConfig,
  NetworkDsdMode,
  NetworkPlayerFormats,
  NetworkStreamQuality,
  NowPlayingSnapshot,
  OutputDevice,
  OutputMode,
  OutputStatus,
  QueueSnapshot,
  RepeatMode,
  Track,
} from '../types.js';

function rendererDevice(r: UpnpRenderer): OutputDevice {
  return {
    uid: rendererUid(r.udn),
    name: r.name,
    kind: 'network',
    supportsExclusive: false,
    supportsDop: false,
    isExternal: false,
    manufacturer: r.manufacturer,
    model: r.modelName,
  };
}

export class PlaybackService extends EventEmitter {
  private queue: Track[] = [];
  private index: number | null = null;
  private shuffle = false;
  private repeat: RepeatMode = 'off';
  private current: Track | null = null;
  /** Bumped by every load; an older load that finishes late is dropped. */
  private loadSeq = 0;

  constructor(
    private catalogue: Catalogue,
    private getConfig: () => HarborConfig,
    private saveConfig: (cfg: HarborConfig) => void,
    private browser: RendererBrowser,
    private network: NetworkPlayer
  ) {
    super();
    engineEvents.on('state', () => this.emitUpdate());
    engineEvents.on('ended', () => {
      if (!this.usingNetwork()) void this.next();
    });
    network.on('change', () => this.emitNowPlaying());
    network.on('trackEnded', (track: Track) => void this.networkTrackEnded(track));
    browser.on('change', () => {
      this.rememberDeviceName();
      this.emitNowPlaying();
    });
  }

  /** The stored pick is a network player (even while it is off). */
  private usingNetwork(): boolean {
    return isNetworkUid(this.getConfig().output.device_uid);
  }

  outputStatus(): OutputStatus {
    const cfg = this.getConfig();
    const uid = cfg.output.device_uid ?? null;
    const network = isNetworkUid(uid);
    const base = buildOutputStatus(
      uid,
      cfg.output.mode,
      this.browser.renderers.map(rendererDevice),
      cfg.output.backend
    );
    const selected = uid ? (base.devices.find((d) => d.uid === uid) ?? null) : null;
    return {
      ...base,
      selectedName: selected?.name ?? cfg.output.device_name ?? null,
      selectedKind: uid ? (network ? 'network' : 'local') : null,
      selectedAvailable: uid ? Boolean(selected || (network && this.browser.find(uid))) : true,
      // Exclusive and DoP need a DAC on this host.
      effectiveMode: network ? 'shared' : base.effectiveMode,
      volume: network ? this.network.volume : base.volume,
      conversionBadge: network ? (this.current ? this.network.pathLabel : null) : base.conversionBadge,
      networkStream: cfg.output.network_stream,
      networkDsd: network ? this.dsdModeFor(uid) : 'auto',
      discoveryError: this.browser.lastError,
    };
  }

  /** What a network player lists and its volume, with the DSD mode stored for it. */
  async networkFormats(uid: string): Promise<NetworkPlayerFormats> {
    const found = await this.network.capabilities(uid);
    return {
      uid,
      online: found !== null,
      listed: Boolean(found?.sink.trim()),
      dsd: found ? sinkDsdTypes(found.sink) : [],
      nativeDsd: found ? nativeDsdContainers(found.sink) : [],
      volume: found?.volume ?? null,
      dsdMode: this.dsdModeFor(uid),
    };
  }

  snapshot(): NowPlayingSnapshot {
    const output = this.outputStatus();
    if (this.usingNetwork()) {
      const n = this.network;
      const hasTrack = Boolean(this.current);
      return {
        state: hasTrack ? n.state : 'idle',
        track: this.current,
        positionSecs: hasTrack ? n.positionNow() : 0,
        durationSecs: n.durationSecs || this.current?.durationSecs || null,
        shuffle: this.shuffle,
        repeat: this.repeat,
        volume: n.volume,
        output,
        conversionBadge: hasTrack ? n.pathLabel : null,
        error: n.error,
      };
    }
    const eng = engineGetState();
    return {
      state: eng?.state ?? 'idle',
      track: this.current,
      positionSecs: eng?.positionSecs ?? 0,
      durationSecs: eng?.durationSecs ?? this.current?.durationSecs ?? null,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: eng?.volume ?? output.volume,
      output,
      conversionBadge: eng?.conversionBadge ?? output.conversionBadge,
      error: eng?.error ?? null,
    };
  }

  queueSnapshot(): QueueSnapshot {
    return { tracks: this.queue, currentIndex: this.index };
  }

  /** One M-SEARCH now — when the output picker opens. */
  discoverNetworkPlayers(): void {
    this.browser.searchNow();
  }

  async playTrack(cataloguePath: string): Promise<void> {
    const track = this.catalogue.getTrack(cataloguePath);
    if (!track) throw new Error('Track not found');

    // Playing one SACD track queues the whole disc so next/prev + prefetch work.
    const sacd = parseSacdPath(cataloguePath);
    if (sacd) {
      try {
        const disc = listSacdTracks(sacd.filePath)
          .map((t) => this.catalogue.getTrack(t.cataloguePath))
          .filter((t): t is Track => Boolean(t));
        if (disc.length) {
          const idx = Math.max(
            0,
            disc.findIndex((t) => t.cataloguePath === cataloguePath)
          );
          await this.playTracks(disc, idx);
          return;
        }
      } catch {
        // Fall through to album queue.
      }
    }

    // Default: queue the whole album so next/prev advance through siblings.
    const album = this.catalogue.albumTracksForPath(cataloguePath);
    const idx = Math.max(
      0,
      album.findIndex((t) => t.cataloguePath === cataloguePath)
    );
    await this.playTracks(album.length ? album : [track], idx);
  }

  async playTracks(tracks: Track[], startIndex = 0): Promise<void> {
    if (!tracks.length) return;
    this.queue = tracks;
    this.index = Math.min(Math.max(0, startIndex), tracks.length - 1);
    await this.loadAndPlay(tracks[this.index]!);
  }

  async transport(cmd: TransportCommand): Promise<void> {
    const net = this.usingNetwork();
    switch (cmd.type) {
      case 'play':
        await this.resume();
        break;
      case 'pause':
        if (net) this.network.pause();
        else enginePause();
        break;
      case 'toggle':
        if (this.isPlaying()) {
          if (net) this.network.pause();
          else enginePause();
        } else {
          await this.resume();
        }
        break;
      case 'stop':
        this.loadSeq += 1;
        engineStop();
        this.network.stop();
        this.current = null;
        break;
      case 'next':
        await this.next();
        break;
      case 'previous':
        await this.previous();
        break;
      case 'seek':
        if (net) this.network.seek(cmd.seconds);
        else engineSeek(cmd.seconds);
        break;
      case 'setVolume':
        if (net) this.network.setVolume(cmd.level);
        else engineSetVolume(cmd.level);
        break;
      case 'setShuffle':
        this.shuffle = cmd.enabled;
        break;
      case 'setRepeat':
        this.repeat = cmd.mode;
        // The renderer may hold a different next track now.
        void this.prepareFollowingTrack();
        break;
    }
    this.emitUpdate();
  }

  /**
   * Picks the output (`upnp:<UDN>` = network player) and how to play to it; `networkDsd` is
   * stored for that player. Moving between this host and a network player carries the current
   * track over at the same position.
   */
  async setOutput(
    deviceUid: string | null,
    mode: OutputMode,
    backend?: AudioBackend,
    networkStream?: NetworkStreamQuality,
    networkDsd?: NetworkDsdMode
  ): Promise<void> {
    const cfg = this.getConfig();
    const previousUid = cfg.output.device_uid ?? null;
    const previousDsdPath = this.dsdPath();
    // Read from the output that plays now, before the pick changes.
    const was = { at: this.positionNow(), playing: this.isPlaying() };
    cfg.output.device_uid = deviceUid;
    cfg.output.mode = mode;
    if (backend) cfg.output.backend = backend;
    if (networkStream) cfg.output.network_stream = networkStream;
    if (networkDsd && isNetworkUid(deviceUid)) this.storeDsdMode(deviceUid, networkDsd);
    if (deviceUid !== previousUid) cfg.output.device_name = this.deviceName(deviceUid);
    this.saveConfig(cfg);

    const toNetwork = isNetworkUid(deviceUid);
    const moves = deviceUid !== previousUid && (toNetwork || isNetworkUid(previousUid));
    // Same player, other stream or DSD mode: only what DSD becomes changes.
    const dsdChanged = toNetwork && deviceUid === previousUid && this.dsdPath() !== previousDsdPath;
    const restream = dsdChanged && this.current !== null && isDsdTrack(this.current);
    const carry = this.current && (moves || restream) ? { track: this.current, ...was } : null;

    if (toNetwork) {
      this.loadSeq += 1;
      engineStop();
    }
    applyOutput(toNetwork ? null : deviceUid, mode, cfg.output.dsd_pcm_level, cfg.output.backend);
    this.network.setStreamQuality(cfg.output.network_stream);
    this.network.setDsdMode(toNetwork ? this.dsdModeFor(deviceUid) : 'auto');
    this.network.setOutputDevice(toNetwork ? deviceUid : null);
    if (carry) {
      await this.loadAndPlay(carry.track, carry.at, carry.playing);
    } else if (dsdChanged) {
      // The armed next track may be DSD made the old way.
      void this.prepareFollowingTrack();
    }
    this.emitUpdate();
  }

  applyConfigOutput(): void {
    const cfg = this.getConfig();
    const uid = cfg.output.device_uid ?? null;
    applyOutput(isNetworkUid(uid) ? null : uid, cfg.output.mode, cfg.output.dsd_pcm_level, cfg.output.backend);
    this.network.setStreamQuality(cfg.output.network_stream);
    this.network.setDsdLevel(cfg.output.dsd_pcm_level);
    this.network.setDsdMode(isNetworkUid(uid) ? this.dsdModeFor(uid) : 'auto');
    this.network.setOutputDevice(uid);
  }

  /** DSD mode stored for a network player; auto when none is. */
  private dsdModeFor(uid: string): NetworkDsdMode {
    const modes = this.getConfig().network.dsd_modes;
    for (const [key, mode] of Object.entries(modes)) {
      if (sameRendererUid(key, uid)) return mode;
    }
    return 'auto';
  }

  /** Stores the mode under `uid` (auto is the default and is dropped). The caller saves. */
  private storeDsdMode(uid: string, mode: NetworkDsdMode): void {
    const modes = this.getConfig().network.dsd_modes;
    for (const key of Object.keys(modes)) {
      if (sameRendererUid(key, uid)) delete modes[key];
    }
    if (mode !== 'auto') modes[uid] = mode;
  }

  /** What DSD becomes on the picked network player: Wi‑Fi PCM, or its DSD mode. */
  private dsdPath(): string {
    const cfg = this.getConfig();
    const uid = cfg.output.device_uid ?? null;
    if (!isNetworkUid(uid)) return 'local';
    return cfg.output.network_stream === 'wifi' ? 'wifi' : this.dsdModeFor(uid);
  }

  private isPlaying(): boolean {
    if (this.usingNetwork()) return this.network.state === 'playing';
    return engineGetState()?.state === 'playing';
  }

  private positionNow(): number {
    if (this.usingNetwork()) return this.network.positionNow();
    return engineGetState()?.positionSecs ?? 0;
  }

  private async resume(): Promise<void> {
    if (!this.usingNetwork()) {
      enginePlay();
      return;
    }
    if (!this.current) return;
    const n = this.network;
    // A failed load, or a player that left and came back, holds nothing — load the track
    // again at the same place.
    if (n.state === 'idle' || n.state === 'failed' || n.track?.cataloguePath !== this.current.cataloguePath) {
      const at = n.track?.cataloguePath === this.current.cataloguePath ? n.positionNow() : 0;
      await this.loadAndPlay(this.current, at);
      return;
    }
    void n.play();
  }

  private async loadAndPlay(track: Track, at = 0, autoplay = true): Promise<void> {
    const seq = ++this.loadSeq;
    this.current = track;
    this.emitUpdate();

    if (this.usingNetwork()) {
      try {
        await this.network.load(track);
      } catch (err) {
        if (!(err instanceof LoadSuperseded) && seq === this.loadSeq) this.emitUpdate();
        return;
      }
      if (seq !== this.loadSeq) return;
      if (at > 1) this.network.seek(at);
      if (autoplay) {
        // Play may take long (some players buffer before they answer); arm the next track after.
        void this.network.play().then(() => {
          if (seq === this.loadSeq) void this.prepareFollowingTrack();
        });
      } else {
        void this.prepareFollowingTrack();
      }
      this.emitUpdate();
      prefetchSacdNeighbors(track.cataloguePath, 2);
      return;
    }

    const playPath = track.cataloguePath.includes(SACD_MARKER)
      ? await resolveSacdPlaybackPath(track.cataloguePath)
      : track.cataloguePath;
    if (seq !== this.loadSeq) return;
    await engineLoad(playPath);
    if (seq !== this.loadSeq) return;
    if (at > 1) engineSeek(at);
    if (autoplay) enginePlay();
    this.emitUpdate();
    // Demux next tracks while the current one plays.
    prefetchSacdNeighbors(track.cataloguePath, 2);
  }

  /** Arms SetNextAVTransportURI for the track that follows (network output only). */
  private async prepareFollowingTrack(): Promise<void> {
    if (!this.usingNetwork() || !this.current) return;
    const index = this.indexAfterEnd();
    await this.network.prepareNext(index === null ? null : this.queue[index]!);
  }

  /** Where the queue goes when the current track plays out; null at the end. */
  private indexAfterEnd(): number | null {
    if (this.index == null || !this.queue.length) return null;
    if (this.repeat === 'one') return this.index;
    const next = this.index + 1;
    if (next < this.queue.length) return next;
    return this.repeat === 'all' ? 0 : null;
  }

  private async networkTrackEnded(ended: Track): Promise<void> {
    // A late end signal from a track we already left must not skip the current one.
    if (ended.cataloguePath !== this.current?.cataloguePath) return;
    const index = this.indexAfterEnd();
    if (index === null) {
      this.loadSeq += 1;
      this.network.stop();
      this.current = null;
      this.emitUpdate();
      return;
    }
    const next = this.queue[index]!;
    this.index = index;
    // Gapless: the renderer already plays the track SetNext armed — take it without a reload.
    const adopted = this.network.adoptPreparedNext();
    if (adopted && adopted.cataloguePath === next.cataloguePath) {
      this.current = adopted;
      this.emitUpdate();
      void this.prepareFollowingTrack();
      prefetchSacdNeighbors(next.cataloguePath, 2);
      return;
    }
    await this.loadAndPlay(next);
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
        this.loadSeq += 1;
        engineStop();
        this.network.stop();
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
    if (this.positionNow() > 3) {
      if (this.usingNetwork()) this.network.seek(0);
      else engineSeek(0);
      this.emitUpdate();
      return;
    }
    const prev = Math.max(0, this.index - 1);
    this.index = prev;
    await this.loadAndPlay(this.queue[prev]!);
  }

  private deviceName(uid: string | null): string | null {
    if (!uid) return null;
    return this.outputStatus().devices.find((d) => d.uid === uid)?.name ?? null;
  }

  /** Keeps the pick's name, so it can be shown while the player is off. */
  private rememberDeviceName(): void {
    const cfg = this.getConfig();
    const uid = cfg.output.device_uid ?? null;
    if (!isNetworkUid(uid)) return;
    const name = this.browser.find(uid)?.name;
    if (!name || name === cfg.output.device_name) return;
    cfg.output.device_name = name;
    this.saveConfig(cfg);
  }

  private emitNowPlaying(): void {
    this.emit('nowPlaying', this.snapshot());
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
