import { EventEmitter } from 'node:events';
import {
  applyOutput,
  buildOutputStatus,
  engineGetState,
  engineLoad,
  enginePause,
  enginePlay,
  engineSeek,
  engineSetDsdPcmLevel,
  engineSetVolume,
  engineStop,
  engineEvents,
} from '../engine/bridge.js';
import type { Catalogue } from '../library/catalogue.js';
import { resolveDstDffPlaybackPath } from '../library/dstDff.js';
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
  DsdPcmLevel,
  HarborConfig,
  NetworkDsdMode,
  NetworkPlayerFormats,
  NetworkStreamQuality,
  NowPlayingSnapshot,
  OutputDevice,
  OutputMode,
  OutputStatus,
  PlaybackState,
  QueueSnapshot,
  QueueSource,
  RepeatMode,
  Track,
} from '../types.js';

const LOOSE_QUEUE: QueueSource = { kind: 'Queue', name: null };

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

/** Fisher–Yates; leaves `items` unchanged. */
function shuffledCopy<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Emits `nowPlaying` and `queue` snapshots, and `settings` when the output Settings show
 * changes (pick, mode, network stream / DSD, DSD level, the players on the network).
 */
export class PlaybackService extends EventEmitter {
  /** Play order (shuffled when shuffle is on). */
  private queue: Track[] = [];
  /** Album / selection order; used to restore when shuffle turns off. */
  private ordered: Track[] = [];
  private index: number | null = null;
  private source: QueueSource = LOOSE_QUEUE;
  private shuffle = false;
  private repeat: RepeatMode = 'off';
  private current: Track | null = null;
  /** Bumped by every load; an older load that finishes late is dropped. */
  private loadSeq = 0;
  /** The load still running; a pause meanwhile keeps it from starting. */
  private loadingSeq: number | null = null;
  private playWhenLoaded = true;
  /** What the picked network player lists, for Settings; null for any other pick. */
  private pickedFormats: NetworkPlayerFormats | null = null;
  private queueSignature = '';

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
      this.refreshPickedFormats();
      this.emitNowPlaying();
      this.settingsChanged();
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
      dsdPcmLevel: cfg.output.dsd_pcm_level,
      discoveryError: this.browser.lastError,
    };
  }

  /** What a network player lists and its volume, with the DSD mode stored for it. */
  async networkFormats(uid: string): Promise<NetworkPlayerFormats> {
    const found = await this.network.capabilities(uid);
    const formats: NetworkPlayerFormats = {
      uid,
      online: found !== null,
      listed: Boolean(found?.sink.trim()),
      dsd: found ? sinkDsdTypes(found.sink) : [],
      nativeDsd: found ? nativeDsdContainers(found.sink) : [],
      volume: found?.volume ?? null,
      dsdMode: this.dsdModeFor(uid),
    };
    const picked = this.getConfig().output.device_uid;
    if (picked && sameRendererUid(picked, uid)) {
      const before = this.pickedFormats;
      this.pickedFormats = formats;
      if (before?.online !== formats.online || before?.nativeDsd.join() !== formats.nativeDsd.join()) {
        this.settingsChanged();
      }
    }
    return formats;
  }

  /** What the picked network player listed when last asked; null for a pick on this host. */
  pickedNetworkFormats(): NetworkPlayerFormats | null {
    return this.pickedFormats;
  }

  snapshot(): NowPlayingSnapshot {
    const output = this.outputStatus();
    const loading = this.loadInFlight();
    const queue = { queueIndex: this.index, queueCount: this.queue.length, queueSource: this.source };
    if (this.usingNetwork()) {
      const n = this.network;
      const hasTrack = Boolean(this.current);
      return {
        state: this.playbackState(),
        track: this.current,
        positionSecs: hasTrack && !loading ? n.positionNow() : 0,
        durationSecs: n.durationSecs || this.current?.durationSecs || null,
        shuffle: this.shuffle,
        repeat: this.repeat,
        volume: n.volume,
        output,
        conversionBadge: hasTrack ? n.pathLabel : null,
        error: n.error,
        ...queue,
      };
    }
    const eng = engineGetState();
    return {
      state: this.playbackState(),
      track: this.current,
      positionSecs: loading ? 0 : (eng?.positionSecs ?? 0),
      durationSecs: (loading ? null : eng?.durationSecs) ?? this.current?.durationSecs ?? null,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: eng?.volume ?? output.volume,
      output,
      conversionBadge: eng?.conversionBadge ?? output.conversionBadge,
      error: eng?.error ?? null,
      ...queue,
    };
  }

  queueSnapshot(): QueueSnapshot {
    return { tracks: this.queue, currentIndex: this.index, source: this.source };
  }

  /** Whether `cataloguePath` is loaded and playing, paused or loading — a tap on it then toggles. */
  isCurrentTrack(cataloguePath: string): boolean {
    if (this.current?.cataloguePath !== cataloguePath) return false;
    const state = this.playbackState();
    return state === 'playing' || state === 'paused' || state === 'loading';
  }

  /** One M-SEARCH now — when the output picker opens. */
  discoverNetworkPlayers(): void {
    this.browser.searchNow();
  }

  /** Plays the track in its album (an SACD track in its disc); the track playing now pauses or resumes. */
  async playTrack(cataloguePath: string): Promise<void> {
    if (this.isCurrentTrack(cataloguePath)) {
      await this.transport({ type: 'toggle' });
      return;
    }
    const track = this.catalogue.getTrack(cataloguePath);
    if (!track) throw new Error('Track not found');
    const source: QueueSource = { kind: 'Album', name: track.album };

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
          await this.playTracks(disc, idx, source);
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
    await this.playTracks(album.length ? album : [track], idx, source);
  }

  /** Queues `tracks` from `source` (else the start track's album) and plays from `startIndex`. */
  async playTracks(tracks: Track[], startIndex = 0, source?: QueueSource): Promise<void> {
    if (!tracks.length) return;
    this.ordered = tracks.slice();
    const start = Math.min(Math.max(0, startIndex), tracks.length - 1);
    const album = tracks[start]!.album;
    this.source = source?.name ? source : album ? { kind: 'Album', name: album } : LOOSE_QUEUE;
    if (this.shuffle && tracks.length > 1) {
      const rest = shuffledCopy(tracks.filter((_, i) => i !== start));
      this.queue = [tracks[start]!, ...rest];
      this.index = 0;
    } else {
      this.queue = tracks.slice();
      this.index = start;
    }
    await this.loadAndPlay(this.queue[this.index]!);
  }

  /** Jumps to `index` of the play order without drawing it again; the track playing now toggles. */
  async playQueueIndex(index: number): Promise<void> {
    const track = this.queue[index];
    if (!track) return;
    this.index = index;
    if (this.isCurrentTrack(track.cataloguePath)) {
      await this.transport({ type: 'toggle' });
      return;
    }
    await this.loadAndPlay(track);
  }

  /** Rebuild play order from `ordered`, keeping the current track under the playhead. */
  private applyShuffle(enabled: boolean): void {
    if (enabled === this.shuffle) return;
    this.shuffle = enabled;
    if (!this.ordered.length) {
      void this.prepareFollowingTrack();
      return;
    }
    const currentPath = this.current?.cataloguePath ?? this.queue[this.index ?? 0]?.cataloguePath;
    if (enabled && this.ordered.length > 1) {
      const current =
        this.ordered.find((t) => t.cataloguePath === currentPath) ?? this.ordered[0]!;
      const rest = shuffledCopy(
        this.ordered.filter((t) => t.cataloguePath !== current.cataloguePath)
      );
      this.queue = [current, ...rest];
      this.index = 0;
    } else {
      this.queue = this.ordered.slice();
      const idx = currentPath
        ? this.queue.findIndex((t) => t.cataloguePath === currentPath)
        : 0;
      this.index = idx >= 0 ? idx : 0;
    }
    void this.prepareFollowingTrack();
  }

  async transport(cmd: TransportCommand): Promise<void> {
    const net = this.usingNetwork();
    const loading = this.loadInFlight();
    switch (cmd.type) {
      case 'play':
        if (loading) this.setPlayWhenLoaded(true);
        else await this.resume();
        break;
      case 'pause':
        if (loading) this.setPlayWhenLoaded(false);
        else if (net) this.network.pause();
        else enginePause();
        break;
      case 'toggle':
        if (loading) {
          this.setPlayWhenLoaded(!this.playWhenLoaded);
        } else if (this.isPlaying()) {
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
        this.applyShuffle(cmd.enabled);
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
    const was = {
      at: this.positionNow(),
      playing: this.loadInFlight() ? this.playWhenLoaded : this.isPlaying(),
    };
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
    this.refreshPickedFormats();
    this.settingsChanged();
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
    this.refreshPickedFormats();
  }

  /** Gain on DSD played as PCM — here and on network players; DoP and native DSD are untouched. */
  setDsdPcmLevel(level: DsdPcmLevel): void {
    const cfg = this.getConfig();
    if (cfg.output.dsd_pcm_level === level) return;
    cfg.output.dsd_pcm_level = level;
    this.saveConfig(cfg);
    engineSetDsdPcmLevel(level);
    this.network.setDsdLevel(level);
    this.settingsChanged();
    this.emitNowPlaying();
  }

  /** Something the output Settings show changed. */
  settingsChanged(): void {
    this.emit('settings');
  }

  /** Asks the picked network player what it lists when the pick changes or comes and goes. */
  private refreshPickedFormats(): void {
    const uid = this.getConfig().output.device_uid ?? null;
    if (!isNetworkUid(uid)) {
      if (this.pickedFormats) {
        this.pickedFormats = null;
        this.settingsChanged();
      }
      return;
    }
    const known = this.pickedFormats;
    if (known && !sameRendererUid(known.uid, uid)) this.pickedFormats = null;
    else if (known && known.online === Boolean(this.browser.find(uid))) return;
    void this.networkFormats(uid).catch(() => undefined);
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

  /** A track is still loading (SACD extraction, a network player taking the URL…). */
  private loadInFlight(): boolean {
    return this.loadingSeq !== null && this.loadingSeq === this.loadSeq;
  }

  /** While loading: loading, or paused once a pause came in; else what the output reports. */
  private playbackState(): PlaybackState {
    if (this.loadInFlight()) return this.playWhenLoaded ? 'loading' : 'paused';
    if (this.usingNetwork()) return this.current ? this.network.state : 'idle';
    return engineGetState()?.state ?? 'idle';
  }

  /** Play / pause during a load: whether the track starts once it is ready. */
  private setPlayWhenLoaded(play: boolean): void {
    this.playWhenLoaded = play;
    if (play) return;
    // The previous track may still sound while the next one loads.
    if (this.usingNetwork()) this.network.pause();
    else enginePause();
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
    this.loadingSeq = seq;
    this.playWhenLoaded = autoplay;
    this.emitUpdate();

    if (this.usingNetwork()) {
      try {
        await this.network.load(track);
      } catch (err) {
        if (seq === this.loadSeq) {
          this.loadingSeq = null;
          if (!(err instanceof LoadSuperseded)) this.emitUpdate();
        }
        return;
      }
      if (seq !== this.loadSeq) return;
      this.loadingSeq = null;
      if (at > 1) this.network.seek(at);
      if (this.playWhenLoaded) {
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

    try {
      const playPath = track.cataloguePath.includes(SACD_MARKER)
        ? await resolveSacdPlaybackPath(track.cataloguePath)
        : await resolveDstDffPlaybackPath(track.cataloguePath);
      if (seq !== this.loadSeq) return;
      await engineLoad(playPath);
      if (seq !== this.loadSeq) return;
    } catch (err) {
      if (seq === this.loadSeq) {
        this.loadingSeq = null;
        this.emitUpdate();
      }
      throw err;
    }
    this.loadingSeq = null;
    if (at > 1) engineSeek(at);
    if (this.playWhenLoaded) enginePlay();
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

  /** Now playing always; the queue only when its tracks, position or source changed. */
  private emitUpdate(): void {
    this.emit('nowPlaying', this.snapshot());
    const queue = this.queueSnapshot();
    const signature = [
      queue.currentIndex,
      queue.source.kind,
      queue.source.name,
      ...queue.tracks.map((t) => t.cataloguePath),
    ].join('\n');
    if (signature === this.queueSignature) return;
    this.queueSignature = signature;
    this.emit('queue', queue);
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

export function isRepeatMode(value: unknown): value is RepeatMode {
  return value === 'off' || value === 'all' || value === 'one';
}
