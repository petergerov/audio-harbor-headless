import { engineNetStreamClose, engineNetStreamOpen, engineNetStreamRead } from '../engine/bridge.js';
import { SACD_MARKER } from '../library/sacd.js';
import type { AudioFormat, NetworkDsdMode, NetworkStreamQuality, Track } from '../types.js';
import { formatTime } from './controlPoint.js';
import { DLNA_FEATURES } from './mediaHttp.js';
import { escapeXml } from './xml.js';

/** Containers sent untouched when the renderer's sink list names them. */
const PASSTHROUGH: Partial<Record<AudioFormat, string>> = {
  flac: 'audio/flac',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  alac: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
};

const ALIASES: Record<string, string[]> = {
  'audio/flac': ['audio/flac', 'audio/x-flac'],
  'audio/wav': ['audio/wav', 'audio/x-wav', 'audio/wave'],
  'audio/aiff': ['audio/aiff', 'audio/x-aiff'],
  'audio/mp4': ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  'audio/aac': ['audio/aac', 'audio/aacp', 'audio/x-aac', 'audio/vnd.dlna.adts'],
  'audio/mpeg': ['audio/mpeg', 'audio/mp3'],
};

type DsdContainer = 'dsf' | 'dff';

/**
 * DSD types a player may list, best first: the container by name, then the generic DSD types.
 * An SACD track goes out as its cached DFF.
 */
const DSD_TYPES: Record<DsdContainer, string[]> = {
  dsf: ['audio/x-dsf', 'audio/dsf', 'audio/x-dsd', 'audio/dsd'],
  dff: ['audio/x-dff', 'audio/dff', 'audio/x-dsd', 'audio/dsd'],
};
const ALL_DSD_TYPES = new Set([...DSD_TYPES.dsf, ...DSD_TYPES.dff]);

/** DSF, DFF and SACD tracks: what goes out depends on the player's DSD mode. */
export function isDsdTrack(track: Track): boolean {
  return (
    track.format === 'dsf' ||
    track.format === 'dff' ||
    track.format === 'sacd' ||
    track.cataloguePath.includes(SACD_MARKER)
  );
}

/** The DSD types in a sink list, spelled as the player lists them. */
export function sinkDsdTypes(sink: string): string[] {
  const found: string[] = [];
  for (const entry of sink.split(',')) {
    const listed = entry.split(':')[2]?.trim();
    if (listed && ALL_DSD_TYPES.has(listed.toLowerCase()) && !found.includes(listed)) found.push(listed);
  }
  return found;
}

/** The type to send a DSF / DFF untouched under; null when the player lists none for it. */
function nativeDsdType(container: DsdContainer, sink: string): string | null {
  const listed = sinkDsdTypes(sink);
  for (const wanted of DSD_TYPES[container]) {
    const hit = listed.find((t) => t.toLowerCase() === wanted);
    if (hit) return hit;
  }
  return null;
}

/** The DSD containers that go to the player untouched in auto mode (SACD goes as DFF). */
export function nativeDsdContainers(sink: string): DsdContainer[] {
  return (['dsf', 'dff'] as const).filter((container) => nativeDsdType(container, sink) !== null);
}

/** Whether `http-get:*:audio/flac:…` style sink entries name `mime`. */
export function sinkAccepts(mime: string, sink: string): boolean {
  const names = ALIASES[mime] ?? [mime];
  for (const entry of sink.split(',')) {
    const listed = entry.split(':')[2]?.trim().toLowerCase();
    if (listed && names.includes(listed)) return true;
  }
  // No sink list (GetProtocolInfo failed): assume the common lossless and MP3 containers work.
  if (!sink.trim()) return ['audio/flac', 'audio/wav', 'audio/aiff', 'audio/mp4', 'audio/mpeg'].includes(mime);
  return false;
}

export type NetworkMediaPlan =
  /** The file untouched; dsd = a DSF / DFF (an SACD track as its cached DFF). */
  | { kind: 'file'; mime: string; dsd: boolean }
  /** PCM WAV: DSD converted (~88.2 kHz, or 44.1 kHz on Wi‑Fi), else decoded at the file's rate. */
  | { kind: 'wav'; dsd: boolean; wifi: boolean }
  /** DSD as DoP in a 24-bit WAV at DSD rate / 16. */
  | { kind: 'dop' };

/**
 * File untouched when the player lists its type; else WAV. DSD by the player's mode: auto sends
 * the DSD file when the player lists DSD, else PCM; dop sends DoP. Wi‑Fi makes DSD 44.1 kHz PCM
 * in every mode — DSD and DoP need 4–6× its bandwidth.
 */
export function planNetworkMedia(
  track: Track,
  sink: string,
  quality: NetworkStreamQuality,
  dsdMode: NetworkDsdMode = 'auto'
): NetworkMediaPlan {
  if (isDsdTrack(track)) {
    if (quality === 'wifi') return { kind: 'wav', dsd: true, wifi: true };
    if (dsdMode === 'dop') return { kind: 'dop' };
    const native = dsdMode === 'auto' ? nativeDsdType(track.format === 'dsf' ? 'dsf' : 'dff', sink) : null;
    return native ? { kind: 'file', mime: native, dsd: true } : { kind: 'wav', dsd: true, wifi: false };
  }
  const mime = PASSTHROUGH[track.format];
  if (mime && sinkAccepts(mime, sink)) return { kind: 'file', mime, dsd: false };
  return { kind: 'wav', dsd: false, wifi: false };
}

/** What the Deck and the remote show as the path. */
export function networkPathLabel(plan: NetworkMediaPlan): string {
  if (plan.kind === 'dop') return 'DoP · Network';
  if (plan.kind === 'file') return plan.dsd ? 'DSD · Network' : 'Network';
  if (plan.dsd) return plan.wifi ? 'Wi‑Fi PCM · Network' : 'DSD→PCM · Network';
  return 'PCM · Network';
}

/**
 * DSD rate, channels and length of a DSF / DFF from its header — what the player is told when it
 * gets the file untouched. The engine's DoP reader parses the header; null when it cannot
 * (DST-compressed DFF).
 */
export async function dsdFileInfo(
  file: string
): Promise<{ sampleRate: number; channels: number; durationSecs: number } | null> {
  try {
    const info = await engineNetStreamOpen(file, { dop: true });
    engineNetStreamClose(info.handle);
    // DoP carries 16 DSD samples per frame.
    return { sampleRate: info.sampleRate * 16, channels: info.channels, durationSecs: info.frameCount / info.sampleRate };
  } catch {
    return null;
  }
}

const WAV_HEADER = 44;

/**
 * A PCM WAV made on the fly from the engine, with a computed `Content-Length` so a `Range`
 * request maps to a frame and the renderer can seek.
 */
export class WavStream {
  readonly totalSize: number;
  readonly blockAlign: number;
  private readonly header: Buffer;
  private closed = false;

  private constructor(
    private readonly handle: unknown,
    readonly sampleRate: number,
    readonly channels: number,
    readonly bitsPerSample: number,
    readonly frameCount: number
  ) {
    this.blockAlign = channels * (bitsPerSample / 8);
    // RIFF sizes are 32-bit; a longer stream ends at 4 GB.
    const maxFrames = Math.floor((0xffffffff - WAV_HEADER) / this.blockAlign);
    this.frameCount = Math.min(frameCount, maxFrames);
    const dataSize = this.frameCount * this.blockAlign;
    this.totalSize = WAV_HEADER + dataSize;
    const h = Buffer.alloc(WAV_HEADER);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + dataSize, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * this.blockAlign, 28);
    h.writeUInt16LE(this.blockAlign, 32);
    h.writeUInt16LE(bitsPerSample, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(dataSize, 40);
    this.header = h;
  }

  static async open(
    file: string,
    options: { wifi: boolean; dsdLevel: 0 | 3 | 6; dop?: boolean }
  ): Promise<WavStream> {
    const info = await engineNetStreamOpen(file, options);
    return new WavStream(info.handle, info.sampleRate, info.channels, info.bitsPerSample, info.frameCount);
  }

  get durationSecs(): number {
    return this.frameCount / this.sampleRate;
  }

  /** Bytes [offset, offset + length) of the WAV file; empty once closed. */
  async read(offset: number, length: number): Promise<Buffer> {
    const end = Math.min(this.totalSize, offset + length);
    if (this.closed || offset >= end) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    if (offset < WAV_HEADER) {
      parts.push(this.header.subarray(offset, Math.min(WAV_HEADER, end)));
      offset = Math.min(WAV_HEADER, end);
    }
    if (offset < end) {
      const dataStart = offset - WAV_HEADER;
      const dataEnd = end - WAV_HEADER;
      const firstFrame = Math.floor(dataStart / this.blockAlign);
      const frames = Math.ceil(dataEnd / this.blockAlign) - firstFrame;
      let pcm: Buffer;
      try {
        pcm = await engineNetStreamRead(this.handle, firstFrame, frames);
      } catch {
        return Buffer.alloc(0);
      }
      const wanted = frames * this.blockAlign;
      // The source ran short of what its header promised: silence keeps Content-Length true.
      if (pcm.length < wanted) pcm = Buffer.concat([pcm, Buffer.alloc(wanted - pcm.length)]);
      const skip = dataStart - firstFrame * this.blockAlign;
      parts.push(pcm.subarray(skip, skip + (dataEnd - dataStart)));
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    engineNetStreamClose(this.handle);
  }
}

/** DIDL-Lite for SetAVTransportURI — one music track item. */
export function didlMusicTrack(item: {
  track: Track;
  uri: string;
  mime: string;
  durationSecs: number | null;
  size: number | null;
  sampleRate: number | null;
  bitsPerSample: number | null;
  channels: number | null;
  artworkUrl: string | null;
}): string {
  let attributes = `protocolInfo="http-get:*:${item.mime}:${DLNA_FEATURES}"`;
  if (item.durationSecs && item.durationSecs > 0) attributes += ` duration="${formatTime(item.durationSecs)}"`;
  if (item.size) attributes += ` size="${item.size}"`;
  if (item.sampleRate) attributes += ` sampleFrequency="${item.sampleRate}"`;
  if (item.bitsPerSample) attributes += ` bitsPerSample="${item.bitsPerSample}"`;
  if (item.channels) attributes += ` nrAudioChannels="${item.channels}"`;
  const t = item.track;
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="1" parentID="0" restricted="1">' +
    `<dc:title>${escapeXml(t.title)}</dc:title>` +
    `<dc:creator>${escapeXml(t.artist)}</dc:creator>` +
    `<upnp:artist>${escapeXml(t.artist)}</upnp:artist>` +
    `<upnp:album>${escapeXml(t.album)}</upnp:album>` +
    (t.trackNumber ? `<upnp:originalTrackNumber>${t.trackNumber}</upnp:originalTrackNumber>` : '') +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    (item.artworkUrl ? `<upnp:albumArtURI>${escapeXml(item.artworkUrl)}</upnp:albumArtURI>` : '') +
    `<res ${attributes}>${escapeXml(item.uri)}</res>` +
    '</item></DIDL-Lite>'
  );
}
