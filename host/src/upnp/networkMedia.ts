import { engineNetStreamClose, engineNetStreamOpen, engineNetStreamRead } from '../engine/bridge.js';
import { SACD_MARKER } from '../library/sacd.js';
import type { AudioFormat, NetworkStreamQuality, Track } from '../types.js';
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

/** DSD and SACD tracks always go out as PCM WAV. */
export function needsTranscode(track: Track): boolean {
  return (
    track.format === 'dsf' ||
    track.format === 'dff' ||
    track.format === 'sacd' ||
    track.cataloguePath.includes(SACD_MARKER)
  );
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
  | { kind: 'file'; mime: string }
  | { kind: 'wav'; dsd: boolean; wifi: boolean };

/** File untouched when the renderer lists its type; else WAV (DSD always, ~88.2 kHz or Wi‑Fi 44.1 kHz). */
export function planNetworkMedia(track: Track, sink: string, quality: NetworkStreamQuality): NetworkMediaPlan {
  if (needsTranscode(track)) return { kind: 'wav', dsd: true, wifi: quality === 'wifi' };
  const mime = PASSTHROUGH[track.format];
  if (mime && sinkAccepts(mime, sink)) return { kind: 'file', mime };
  return { kind: 'wav', dsd: false, wifi: false };
}

/** What the Deck and the remote show as the path. */
export function networkPathLabel(plan: NetworkMediaPlan): string {
  if (plan.kind === 'file') return 'Network';
  if (plan.dsd) return plan.wifi ? 'Wi‑Fi PCM · Network' : 'DSD→PCM · Network';
  return 'PCM · Network';
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

  static async open(file: string, options: { wifi: boolean; dsdLevel: 0 | 3 | 6 }): Promise<WavStream> {
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
