import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Catalogue } from '../library/catalogue.js';
import { resolveDstDffPlaybackPath } from '../library/dstDff.js';
import { resolveSacdPlaybackPath, SACD_MARKER } from '../library/sacd.js';
import type { KeepAwake } from '../power.js';
import type { NetworkDsdMode, NetworkStreamQuality, PlaybackState, Track } from '../types.js';
import * as upnp from './controlPoint.js';
import type { MediaHandle, MediaHttpServer } from './mediaHttp.js';
import {
  didlMusicTrack,
  dsdFileInfo,
  networkPathLabel,
  planNetworkMedia,
  WavStream,
} from './networkMedia.js';
import { isNetworkUid, rendererMatches, ssdpUdn, type RendererBrowser, type UpnpRenderer } from './ssdp.js';

interface PreparedMedia {
  stream: MediaHandle;
  artwork: MediaHandle | null;
  url: string;
  metadata: string;
  pathLabel: string;
  durationSecs: number | null;
  via: string;
}

/** A newer load replaced this one — nothing to show. */
export class LoadSuperseded extends Error {
  constructor() {
    super('Load superseded');
    this.name = 'LoadSuperseded';
  }
}

const POLL_PLAYING_MS = 1000;
const POLL_PAUSED_MS = 5000;
/** Polls in a row without an answer before the player counts as gone. */
const LOST_AFTER_FAILED_POLLS = 5;
/** Play accepted but never PLAYING: the renderer could not fetch or decode the stream. */
const START_TIMEOUT_MS = 20_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether two stream URLs name the same token (renderers may rewrite the host part). */
function sameStream(a: string, b: string): boolean {
  try {
    return new URL(a).pathname === new URL(b).pathname;
  } catch {
    return a === b;
  }
}

/**
 * Plays to a UPnP MediaRenderer: serves the track over HTTP, drives AVTransport, polls the
 * position, follows the volume through RenderingControl and arms the next track for gapless.
 * Emits `change` for anything Now Playing shows and `trackEnded` with the track that ended.
 */
export class NetworkPlayer extends EventEmitter {
  state: PlaybackState = 'idle';
  error: string | null = null;
  durationSecs = 0;
  /** Network · PCM · Network · DSD · Network · DoP · Network · DSD→PCM · Network · Wi‑Fi PCM · Network */
  pathLabel = 'Network';
  /** Renderer volume 0…1; null while unknown, without RenderingControl volume, or locked for DoP. */
  volume: number | null = null;

  private preferredUid: string | null = null;
  /** Last resolved renderer for the pick — kept across brief SSDP drops. */
  private pinned: UpnpRenderer | null = null;
  private loadedTrack: Track | null = null;
  private current: PreparedMedia | null = null;
  private nextTrack: Track | null = null;
  private nextMedia: PreparedMedia | null = null;
  /** Set when gapless already moved on; adoptPreparedNext() hands it over once. */
  private pendingAdoption: Track | null = null;
  private generation = 0;
  private nextGeneration = 0;
  private position = 0;
  private positionAt = 0;
  /** Where to go once the renderer plays (after a load, or after it stopped on its own). */
  private pendingSeek: number | null = null;
  /** The renderer reported PLAYING for this track. */
  private sawPlaying = false;
  /** RelTime moved past 0 — the renderer reports a position we can trust. */
  private reportsPosition = false;
  private playSentAt = 0;
  private stoppedPolls = 0;
  private failedPolls = 0;
  private pollCount = 0;
  private pollEpoch = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private volumeWanted: number | null = null;
  private volumeSending = false;
  private sinkByUdn = new Map<string, string>();
  /** false once a renderer refused SetNextAVTransportURI. */
  private setNextByUdn = new Map<string, boolean>();
  private quality: NetworkStreamQuality = 'full';
  private dsdLevel: 0 | 3 | 6 = 3;
  /** DSD mode of the pick; dop also locks the volume. */
  private dsdMode: NetworkDsdMode = 'auto';
  /** The failure is the renderer going away — cleared when it is back. */
  private rendererLost = false;

  constructor(
    private readonly browser: RendererBrowser,
    private readonly media: MediaHttpServer,
    private readonly catalogue: Catalogue,
    private readonly keepAwake: KeepAwake
  ) {
    super();
    browser.on('change', () => this.handleRendererListChanged());
  }

  /** The picked renderer: live from discovery, else the pinned one. */
  get renderer(): UpnpRenderer | null {
    const uid = this.preferredUid;
    if (!uid) return null;
    const live = this.browser.find(uid);
    if (live) {
      this.pinned = live;
      return live;
    }
    return this.pinned && rendererMatches(this.pinned, uid) ? this.pinned : null;
  }

  get track(): Track | null {
    return this.loadedTrack;
  }

  /** Seconds into the track, moving between polls while playing. */
  positionNow(): number {
    let p = this.position;
    if (this.state === 'playing' && this.sawPlaying && this.pendingSeek === null) {
      p += (Date.now() - this.positionAt) / 1000;
    }
    return this.durationSecs > 0 ? Math.min(p, this.durationSecs) : p;
  }

  setStreamQuality(quality: NetworkStreamQuality): void {
    const locked = this.volumeLocked;
    this.quality = quality;
    this.volumeLockChanged(locked);
  }

  setDsdLevel(level: 0 | 3 | 6): void {
    this.dsdLevel = level;
  }

  /** How the pick gets DSD. */
  setDsdMode(mode: NetworkDsdMode): void {
    const locked = this.volumeLocked;
    this.dsdMode = mode;
    this.volumeLockChanged(locked);
  }

  /**
   * DoP passes only when nothing scales the samples: while DSD goes out as DoP (dop mode, Full
   * stream) the volume stays where it is — no SetVolume, and the remote shows none.
   */
  private get volumeLocked(): boolean {
    return this.dsdMode === 'dop' && this.quality === 'full';
  }

  private volumeLockChanged(wasLocked: boolean): void {
    if (this.volumeLocked === wasLocked) return;
    if (this.volumeLocked) {
      this.volumeWanted = null;
      this.volume = null;
    } else {
      void this.refreshVolume();
    }
    this.emitChange();
  }

  /** Points at a network pick (`upnp:<UDN>`), or at nothing. Stops on the previous renderer. */
  setOutputDevice(uid: string | null): void {
    const next = isNetworkUid(uid) ? uid : null;
    if (next === this.preferredUid) return;
    if (this.loadedTrack || this.state !== 'idle') this.stop();
    this.preferredUid = next;
    this.pinned = next ? this.browser.find(next) : null;
    if (next) this.forgetCapabilities(next);
    this.volume = null;
    this.error = null;
    if (next) void this.refreshVolume();
    this.emitChange();
  }

  async load(track: Track): Promise<void> {
    const gen = ++this.generation;
    this.stopPolling();
    this.clearNext();
    this.clearCurrent();
    this.pendingAdoption = null;
    this.loadedTrack = track;
    this.sawPlaying = false;
    this.reportsPosition = false;
    this.pendingSeek = null;
    this.stoppedPolls = 0;
    this.failedPolls = 0;
    this.setPosition(0);
    this.durationSecs = track.durationSecs ?? 0;
    this.pathLabel = 'Network';
    this.error = null;
    this.setState('loading');

    let renderer = this.renderer;
    if (!renderer) {
      this.browser.searchNow();
      renderer = await this.waitForRenderer(4000);
      if (gen !== this.generation) throw new LoadSuperseded();
    }
    if (!renderer) {
      this.fail('Network player is not available — pick it again when it is back on the network.');
      throw new Error(this.error!);
    }

    let prepared: PreparedMedia;
    try {
      prepared = await this.prepareMedia(track, renderer);
    } catch (err) {
      if (gen !== this.generation) throw new LoadSuperseded();
      this.fail(`Cannot stream this track: ${message(err)}`);
      throw err;
    }
    if (gen !== this.generation) {
      this.release(prepared);
      throw new LoadSuperseded();
    }
    this.current = prepared;
    this.pathLabel = prepared.pathLabel;
    if (prepared.durationSecs) this.durationSecs = prepared.durationSecs;

    try {
      await upnp.setAVTransportURI(renderer, prepared.url, prepared.metadata);
    } catch (err) {
      if (gen !== this.generation) throw new LoadSuperseded();
      this.clearCurrent();
      this.fail(`${renderer.name}: ${message(err)}`);
      throw err;
    }
    if (gen !== this.generation) throw new LoadSuperseded();
    this.setState('paused');
    console.log(`Network: ${track.title} on ${renderer.name} as ${prepared.via}`);
    if (this.volume === null) void this.refreshVolume();
  }

  /** Starts or resumes; resolves once the renderer took the command (or gave up). */
  async play(): Promise<void> {
    const renderer = this.renderer;
    if (!renderer || !this.loadedTrack || this.state === 'failed' || this.state === 'idle') return;
    const gen = this.generation;
    this.playSentAt = Date.now();
    this.setState('playing');
    this.startPolling(400);
    try {
      await upnp.play(renderer);
    } catch (err) {
      if (gen !== this.generation) return;
      // Bose and some DLNA boxes hold the Play reply until HTTP has buffered — it times out
      // although the transport is already PLAYING.
      const started = upnp.isTimeout(err) && (await this.waitUntilPlaying(renderer, 20_000));
      if (gen !== this.generation) return;
      if (!started) {
        this.fail(`${renderer.name}: ${message(err)}`);
        return;
      }
    }
    if (gen !== this.generation) return;
    this.positionAt = Date.now();
    if (this.pendingSeek !== null && this.pendingSeek > 1) {
      const target = this.pendingSeek;
      // Many renderers take Seek while TRANSITIONING; the rest get it again at PLAYING.
      void upnp.seek(renderer, target).then(
        () => {
          if (gen === this.generation && this.pendingSeek === target) {
            this.pendingSeek = null;
            this.setPosition(target);
          }
        },
        () => undefined
      );
    } else {
      this.pendingSeek = null;
    }
  }

  pause(): void {
    const renderer = this.renderer;
    if (!renderer || !this.loadedTrack || this.state !== 'playing') return;
    this.freezePosition();
    this.setState('paused');
    this.startPolling(POLL_PAUSED_MS);
    const gen = this.generation;
    void upnp.pause(renderer).catch(async (err) => {
      if (gen !== this.generation) return;
      // Pause is optional in AVTransport: stop instead and come back to the same place.
      console.warn(`Network pause: ${message(err)} — stopping instead`);
      this.pendingSeek = this.position;
      this.sawPlaying = false;
      await upnp.stop(renderer).catch(() => undefined);
    });
  }

  stop(): void {
    const renderer = this.renderer;
    this.generation += 1;
    this.stopPolling();
    this.clearNext();
    this.clearCurrent();
    this.pendingAdoption = null;
    this.pendingSeek = null;
    this.loadedTrack = null;
    this.setPosition(0);
    this.durationSecs = 0;
    this.error = null;
    this.setState('idle');
    if (renderer) void upnp.stop(renderer).catch(() => undefined);
  }

  seek(seconds: number): void {
    const target = Math.max(0, this.durationSecs > 0 ? Math.min(seconds, this.durationSecs) : seconds);
    this.setPosition(target);
    const renderer = this.renderer;
    if (!renderer || !this.loadedTrack) return;
    if (!this.sawPlaying || this.pendingSeek !== null) {
      // The transport is not running yet (Seek would be refused): apply it at PLAYING.
      this.pendingSeek = target;
      this.emitChange();
      return;
    }
    this.emitChange();
    void upnp.seek(renderer, target).catch((err) => console.warn(`Network seek: ${message(err)}`));
  }

  /** 0…1. Coalesced: a slider sends many; the renderer gets the latest. Ignored for DoP. */
  setVolume(level: number): void {
    if (!this.renderer || !Number.isFinite(level) || this.volumeLocked) return;
    const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
    this.volume = percent / 100;
    this.volumeWanted = percent;
    this.emitChange();
    void this.sendVolume();
  }

  // Gapless

  /** Arms SetNextAVTransportURI with the track that follows (null clears it). */
  async prepareNext(track: Track | null): Promise<void> {
    this.clearNext();
    const gen = this.nextGeneration;
    const renderer = this.renderer;
    if (!track || !renderer || !this.loadedTrack || this.state === 'failed') return;
    const udn = ssdpUdn(renderer.udn);
    if (this.setNextByUdn.get(udn) === false) return;
    let prepared: PreparedMedia;
    try {
      prepared = await this.prepareMedia(track, renderer);
    } catch (err) {
      console.warn(`Network next track: ${message(err)}`);
      return;
    }
    if (gen !== this.nextGeneration) {
      this.release(prepared);
      return;
    }
    try {
      await upnp.setNextAVTransportURI(renderer, prepared.url, prepared.metadata);
    } catch (err) {
      this.release(prepared);
      if (err instanceof upnp.UpnpError && gen === this.nextGeneration) {
        this.setNextByUdn.set(udn, false);
        console.log(`${renderer.name} has no SetNext — tracks change with a short gap`);
      }
      return;
    }
    if (gen !== this.nextGeneration) {
      this.release(prepared);
      return;
    }
    this.setNextByUdn.set(udn, true);
    this.nextTrack = track;
    this.nextMedia = prepared;
  }

  /** The track gapless already moved to, once — so the queue takes it over without a reload. */
  adoptPreparedNext(): Track | null {
    const track = this.pendingAdoption;
    this.pendingAdoption = null;
    return track;
  }

  /**
   * What a player on the network lists (GetProtocolInfo sink, '' when it gives none) and its
   * volume 0…1 — for the output picker. null when it is not on the network.
   */
  async capabilities(uid: string): Promise<{ sink: string; volume: number | null } | null> {
    const renderer =
      this.browser.find(uid) ?? (this.pinned && rendererMatches(this.pinned, uid) ? this.pinned : null);
    if (!renderer) return null;
    const [sink, volume] = await Promise.all([
      this.protocolSink(renderer),
      upnp.getVolume(renderer).then(
        (percent) => Math.min(100, Math.max(0, percent)) / 100,
        () => null
      ),
    ]);
    return { sink, volume };
  }

  // Media

  private async prepareMedia(track: Track, renderer: UpnpRenderer): Promise<PreparedMedia> {
    const sink = await this.protocolSink(renderer);
    const plan = planNetworkMedia(track, sink, this.quality, this.dsdMode);
    // SACD / DST-compressed DFF play from an uncompressed DFF in the cache.
    const source = track.cataloguePath.includes(SACD_MARKER)
      ? await resolveSacdPlaybackPath(track.cataloguePath)
      : await resolveDstDffPlaybackPath(track.cataloguePath);
    let stream: MediaHandle;
    let mime: string;
    let durationSecs = track.durationSecs;
    let size: number | null = null;
    let sampleRate = track.sampleRate;
    let bitsPerSample = track.bitDepth;
    let channels = track.channels;
    let via: string;
    if (plan.kind === 'file') {
      size = (await fs.promises.stat(source)).size;
      const dsd = plan.dsd ? await dsdFileInfo(source) : null;
      if (dsd) {
        durationSecs = dsd.durationSecs;
        sampleRate = dsd.sampleRate;
        bitsPerSample = 1;
        channels = dsd.channels;
      }
      stream = this.media.registerFile(source, plan.mime);
      mime = plan.mime;
      via = plan.mime;
    } else {
      const dop = plan.kind === 'dop';
      const wav = await WavStream.open(source, {
        wifi: !dop && plan.wifi,
        dsdLevel: this.dsdLevel,
        dop,
      });
      stream = this.media.registerWav(wav);
      mime = 'audio/wav';
      durationSecs = wav.durationSecs;
      size = wav.totalSize;
      sampleRate = wav.sampleRate;
      bitsPerSample = wav.bitsPerSample;
      channels = wav.channels;
      const kind = dop ? 'DoP' : plan.dsd ? (plan.wifi ? 'Wi‑Fi PCM' : 'DSD→WAV') : 'WAV';
      via = `${kind} ${wav.sampleRate} Hz / ${wav.bitsPerSample}-bit`;
    }

    let artwork: MediaHandle | null = null;
    try {
      const url = await this.media.urlFor(stream, renderer.host);
      let artworkUrl: string | null = null;
      const artFile = track.artworkHash ? this.catalogue.artworkFile(track.artworkHash) : null;
      if (artFile) {
        artwork = this.media.registerArtwork(await fs.promises.readFile(artFile));
        artworkUrl = await this.media.urlFor(artwork, renderer.host);
      }
      const metadata = didlMusicTrack({
        track,
        uri: url,
        mime,
        durationSecs,
        size,
        sampleRate,
        bitsPerSample,
        channels,
        artworkUrl,
      });
      return { stream, artwork, url, metadata, pathLabel: networkPathLabel(plan), durationSecs, via };
    } catch (err) {
      this.media.unregister(stream);
      this.media.unregister(artwork);
      throw err;
    }
  }

  private forgetCapabilities(uid: string): void {
    const udn = ssdpUdn(uid.startsWith('upnp:') ? uid.slice('upnp:'.length) : uid);
    this.sinkByUdn.delete(udn);
    this.setNextByUdn.delete(udn);
  }

  private async protocolSink(renderer: UpnpRenderer): Promise<string> {
    const udn = ssdpUdn(renderer.udn);
    const cached = this.sinkByUdn.get(udn);
    if (cached !== undefined) return cached;
    let sink = '';
    try {
      sink = (await upnp.getProtocolInfo(renderer)).sink;
    } catch {
      // No ConnectionManager: the planner assumes the common containers work.
    }
    this.sinkByUdn.set(udn, sink);
    return sink;
  }

  private release(prepared: PreparedMedia | null): void {
    if (!prepared) return;
    this.media.unregister(prepared.stream);
    this.media.unregister(prepared.artwork);
  }

  private clearCurrent(): void {
    this.release(this.current);
    this.current = null;
  }

  private clearNext(): void {
    this.nextGeneration += 1;
    this.release(this.nextMedia);
    this.nextTrack = null;
    this.nextMedia = null;
  }

  private promoteNext(): Track {
    const ended = this.loadedTrack!;
    this.release(this.current);
    this.current = this.nextMedia;
    this.loadedTrack = this.nextTrack;
    this.durationSecs = this.nextMedia?.durationSecs ?? this.nextTrack?.durationSecs ?? 0;
    this.pathLabel = this.nextMedia?.pathLabel ?? 'Network';
    this.nextTrack = null;
    this.nextMedia = null;
    this.nextGeneration += 1;
    this.sawPlaying = true;
    this.reportsPosition = false;
    this.pendingSeek = null;
    this.stoppedPolls = 0;
    this.setPosition(0);
    this.pendingAdoption = this.loadedTrack;
    this.setState('playing');
    return ended;
  }

  // Polling

  private startPolling(firstDelayMs: number): void {
    const epoch = ++this.pollEpoch;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const tick = async () => {
      if (epoch !== this.pollEpoch) return;
      await this.pollOnce();
      if (epoch !== this.pollEpoch || (this.state !== 'playing' && this.state !== 'paused')) return;
      this.pollTimer = setTimeout(tick, this.state === 'playing' ? POLL_PLAYING_MS : POLL_PAUSED_MS);
    };
    this.pollTimer = setTimeout(tick, firstDelayMs);
  }

  private stopPolling(): void {
    this.pollEpoch += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    const renderer = this.renderer;
    const track = this.loadedTrack;
    if (!renderer || !track || (this.state !== 'playing' && this.state !== 'paused')) return;
    const gen = this.generation;
    let transport: upnp.TransportInfo;
    let position: upnp.PositionInfo;
    try {
      [transport, position] = await Promise.all([
        upnp.getTransportInfo(renderer),
        upnp.getPositionInfo(renderer),
      ]);
    } catch (err) {
      if (gen !== this.generation) return;
      this.failedPolls += 1;
      if (this.failedPolls >= LOST_AFTER_FAILED_POLLS && this.state === 'playing') {
        this.freezePosition();
        this.fail(`${renderer.name} does not answer — is it still on? (${message(err)})`);
        this.rendererLost = true;
      }
      return;
    }
    if (gen !== this.generation) return;
    this.failedPolls = 0;
    this.pollCount += 1;
    if (this.pollCount % 5 === 0) void this.refreshVolume();

    // Gapless: the renderer already moved to the prepared next URI.
    if (this.nextMedia && this.nextTrack && position.uri && sameStream(position.uri, this.nextMedia.url)) {
      const ended = this.promoteNext();
      if (position.relTime !== null) this.setPosition(position.relTime);
      this.emit('trackEnded', ended);
      return;
    }

    const before = this.positionNow();
    const stopped = transport.state === 'STOPPED' || transport.state === 'NO_MEDIA_PRESENT';
    // A stopped transport reports 0:00:00 — keep our place to tell the end from a stop.
    if (position.relTime !== null && this.pendingSeek === null && !stopped) {
      if (position.relTime > 0) this.reportsPosition = true;
      this.setPosition(position.relTime);
    }
    if (position.duration && position.duration > 0) this.durationSecs = position.duration;

    switch (transport.state) {
      case 'PLAYING': {
        this.stoppedPolls = 0;
        if (!this.sawPlaying) {
          this.sawPlaying = true;
          this.positionAt = Date.now();
          if (this.pendingSeek !== null) {
            const target = this.pendingSeek;
            this.pendingSeek = null;
            if (target > 1) {
              this.setPosition(target);
              void upnp.seek(renderer, target).catch((err) => console.warn(`Network seek: ${message(err)}`));
            }
          }
        }
        if (this.state !== 'playing') this.setState('playing');
        break;
      }
      case 'PAUSED_PLAYBACK':
        // Paused on the device.
        if (this.state === 'playing') {
          this.setState('paused');
        }
        break;
      case 'STOPPED':
      case 'NO_MEDIA_PRESENT':
        this.handleStopped(renderer, transport, track, before);
        break;
      default:
        // TRANSITIONING and friends: wait for the next poll.
        break;
    }
    if (Math.abs(this.positionNow() - before) > 1.5) this.emitChange();
  }

  private handleStopped(
    renderer: UpnpRenderer,
    transport: upnp.TransportInfo,
    track: Track,
    position: number
  ): void {
    if (this.state !== 'playing') return;
    this.stoppedPolls += 1;
    if (!this.sawPlaying) {
      if (transport.status === 'ERROR_OCCURRED' || Date.now() - this.playSentAt > START_TIMEOUT_MS) {
        this.fail(`${renderer.name} could not play this track`);
      }
      return;
    }
    const nearEnd = !this.reportsPosition || this.durationSecs <= 0 || position >= this.durationSecs - 10;
    if (!nearEnd) {
      if (transport.status === 'ERROR_OCCURRED') {
        this.setPosition(position);
        this.fail(`${renderer.name} stopped with an error`);
      } else {
        // Stopped on the device: hold the place, Play resumes there.
        this.setPosition(position);
        this.pendingSeek = position;
        this.sawPlaying = false;
        this.setState('paused');
      }
      return;
    }
    // A renderer may sit in STOPPED for a moment before it takes the prepared next track.
    if (this.nextMedia && this.stoppedPolls < 2) return;
    this.stopPolling();
    this.setPosition(this.durationSecs);
    this.setState('paused');
    this.emit('trackEnded', track);
  }

  private handleRendererListChanged(): void {
    const uid = this.preferredUid;
    if (!uid) return;
    const live = this.browser.find(uid);
    if (live) {
      this.pinned = live;
      if (this.state === 'failed' && this.rendererLost) {
        // Back on the network: Play loads the track again at the same place.
        this.rendererLost = false;
        this.error = null;
        this.setState('idle');
      }
      return;
    }
    // It may come back with other firmware: ask for formats and SetNext again then.
    this.forgetCapabilities(uid);
    // Short max-age drops are common; keep the pin and ask again.
    if (this.pinned) {
      this.browser.searchNow();
      return;
    }
    if (this.loadedTrack && this.state !== 'idle' && this.state !== 'failed') {
      this.freezePosition();
      this.fail('Network player left the network — pick it again when it is back.');
      this.rendererLost = true;
    }
  }

  // Volume

  private async sendVolume(): Promise<void> {
    if (this.volumeSending) return;
    this.volumeSending = true;
    try {
      while (this.volumeWanted !== null) {
        const renderer = this.renderer;
        const percent = this.volumeWanted;
        this.volumeWanted = null;
        if (!renderer || this.volumeLocked) break;
        await upnp.setVolume(renderer, percent).catch((err) => console.warn(`Network volume: ${message(err)}`));
      }
    } finally {
      this.volumeSending = false;
    }
  }

  private async refreshVolume(): Promise<void> {
    const renderer = this.renderer;
    if (!renderer || this.volumeLocked) return;
    try {
      const percent = await upnp.getVolume(renderer);
      if (this.volumeSending || this.volumeWanted !== null || renderer !== this.renderer) return;
      if (this.volumeLocked) return;
      const level = Math.min(100, Math.max(0, percent)) / 100;
      if (level !== this.volume) {
        this.volume = level;
        this.emitChange();
      }
    } catch {
      if (this.volume !== null && renderer === this.renderer && !this.volumeLocked) {
        this.volume = null;
        this.emitChange();
      }
    }
  }

  // State

  private async waitForRenderer(ms: number): Promise<UpnpRenderer | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const renderer = this.renderer;
      if (renderer) return renderer;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.renderer;
  }

  private async waitUntilPlaying(renderer: UpnpRenderer, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const info = await upnp.getTransportInfo(renderer);
        if (info.state === 'PLAYING' || info.state === 'TRANSITIONING') return true;
      } catch {
        /* keep asking */
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }

  private fail(text: string): void {
    this.rendererLost = false;
    this.stopPolling();
    this.clearNext();
    this.error = text;
    this.setState('failed');
    console.warn(`Network: ${text}`);
  }

  private setPosition(seconds: number): void {
    this.position = seconds;
    this.positionAt = Date.now();
  }

  private freezePosition(): void {
    this.setPosition(this.positionNow());
  }

  private setState(state: PlaybackState): void {
    if (state !== this.state) {
      if (this.state === 'playing') this.freezePosition();
      this.state = state;
      if (state === 'playing') this.positionAt = Date.now();
      this.keepAwake.hold(state === 'playing');
    }
    this.emitChange();
  }

  private emitChange(): void {
    this.emit('change');
  }
}
