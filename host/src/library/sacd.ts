import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../paths.js';

/** Virtual catalogue identity: `/path/to/disc.iso#sacd/N` */
export const SACD_MARKER = '#sacd/';

export interface SacdTrackInfo {
  number: number;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: number | null;
  durationSecs: number;
  startLsn: number;
  lengthLsn: number;
  sampleRateHz: number;
  channels: number;
  isDst: boolean;
  cataloguePath: string;
}

const SECTOR = 2048;
const MASTER_LSN = 510;
const FRAMES_PER_SEC = 75;

type SectorLayout = { stride: number; header: number };

const LAYOUT_2048: SectorLayout = { stride: 2048, header: 0 };
const LAYOUT_2352: SectorLayout = { stride: 2352, header: 16 };

function be16(buf: Buffer, off: number): number {
  if (off + 1 >= buf.length) return 0;
  return buf.readUInt16BE(off);
}
function be32(buf: Buffer, off: number): number {
  if (off + 3 >= buf.length) return 0;
  return buf.readUInt32BE(off);
}
function writeU16BE(buf: Buffer, off: number, v: number): void {
  buf.writeUInt16BE(v & 0xffff, off);
}
function writeU32BE(buf: Buffer, off: number, v: number): void {
  buf.writeUInt32BE(v >>> 0, off);
}
function writeU64BE(buf: Buffer, off: number, v: bigint): void {
  buf.writeBigUInt64BE(v, off);
}

function offset(lsn: number, layout: SectorLayout): number {
  return lsn * layout.stride + layout.header;
}

function detectLayout(fd: number): SectorLayout {
  const tryLayout = (layout: SectorLayout): boolean => {
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, offset(MASTER_LSN, layout));
    return buf.toString('ascii') === 'SACDMTOC';
  };
  if (tryLayout(LAYOUT_2048)) return LAYOUT_2048;
  if (tryLayout(LAYOUT_2352)) return LAYOUT_2352;
  throw new Error('not Scarlet Book');
}

function readSector(fd: number, lsn: number, layout: SectorLayout): Buffer {
  const buf = Buffer.alloc(SECTOR);
  const read = fs.readSync(fd, buf, 0, SECTOR, offset(lsn, layout));
  if (read < SECTOR) throw new Error('truncated SACD ISO');
  return buf;
}

function decodeText(raw: Buffer): string {
  return raw.toString('latin1').replace(/\0/g, '').trim();
}

function cString(buf: Buffer, pos: number): string {
  if (pos <= 0 || pos >= buf.length) return '';
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return decodeText(buf.subarray(pos, end));
}

function nonempty(...values: string[]): string {
  return values.find((v) => v.length > 0) ?? '';
}

function parseSacdPath(cataloguePath: string): { filePath: string; track: number } | null {
  const idx = cataloguePath.indexOf(SACD_MARKER);
  if (idx < 0) return null;
  const filePath = cataloguePath.slice(0, idx);
  const track = Number(cataloguePath.slice(idx + SACD_MARKER.length));
  if (!Number.isFinite(track) || track < 1) return null;
  return { filePath, track };
}

export function isSacdIso(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      detectLayout(fd);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

interface AreaInfo {
  trackCount: number;
  sampleRateHz: number;
  channels: number;
  isDst: boolean;
  startLsns: number[];
  lengthLsns: number[];
  durations: number[];
  titles: string[];
  performers: string[];
  trackStart: number;
  trackEnd: number;
}

function parseAreaToc(area: Buffer): AreaInfo {
  const id = area.subarray(0, 8).toString('ascii');
  if (id !== 'TWOCHTOC' && id !== 'MULCHTOC') throw new Error('not Scarlet Book');

  let o = 8;
  o += 2; // version
  const size = be16(area, o);
  o += 2;
  o += 4; // reserved
  o += 4; // max byte rate
  const sampleFrequencyCode = area[o] ?? 0;
  o += 1;
  const frameFormat = (area[o] ?? 0) & 0x0f;
  o += 1;
  o += 10;
  const channels = Math.max(1, area[o] ?? 2);
  o += 1;
  o += 1 + 1 + 1 + 12 + 1 + 15 + 3 + 1 + 1;
  const trackCount = area[o] ?? 0;
  o += 1;
  o += 2;
  const trackStart = be32(area, o);
  o += 4;
  const trackEnd = be32(area, o);
  o += 4;
  o += 1 + 7 + 32 + 8;
  const trackTextOffset = be16(area, o);

  if (trackCount <= 0 || trackCount > 255) throw new Error('truncated SACD ISO');

  const sampleRateHz = sampleFrequencyCode === 0x08 ? 5_644_800 : 2_822_400;
  const isDst = frameFormat === 0;

  const startLsns = Array(trackCount).fill(0);
  const lengthLsns = Array(trackCount).fill(0);
  const durations = Array(trackCount).fill(0);
  let titles = Array(trackCount).fill('');
  let performers = Array(trackCount).fill('');

  const bound = Math.min(area.length, Math.max(size, 2) * SECTOR);
  for (let cursor = SECTOR; cursor + 8 <= bound; cursor += SECTOR) {
    const sig = area.subarray(cursor, cursor + 8).toString('ascii');
    if (sig === 'SACDTRL1') {
      let p = cursor + 8;
      for (let i = 0; i < 255; i++) {
        if (p + 4 > area.length) break;
        if (i < trackCount) startLsns[i] = be32(area, p);
        p += 4;
      }
      for (let i = 0; i < 255; i++) {
        if (p + 4 > area.length) break;
        if (i < trackCount) lengthLsns[i] = be32(area, p);
        p += 4;
      }
    } else if (sig === 'SACDTRL2') {
      let p = cursor + 8 + 255 * 4;
      for (let i = 0; i < 255; i++) {
        if (p + 4 > area.length) break;
        if (i < trackCount) {
          const minutes = area[p] ?? 0;
          const seconds = area[p + 1] ?? 0;
          const frames = area[p + 2] ?? 0;
          durations[i] = minutes * 60 + seconds + frames / FRAMES_PER_SEC;
        }
        p += 4;
      }
    }
  }

  if (trackTextOffset > 0) {
    const textStart = trackTextOffset * SECTOR;
    if (
      textStart + 8 <= area.length &&
      area.subarray(textStart, textStart + 8).toString('ascii') === 'SACDTTxt'
    ) {
      const parsed = parseTrackText(area, textStart, trackCount);
      titles = parsed.titles;
      performers = parsed.performers;
    }
  }

  for (let i = 0; i < trackCount; i++) {
    if (startLsns[i] === 0) {
      if (i === 0) startLsns[i] = trackStart;
      else if (startLsns[i - 1]! > 0 && lengthLsns[i - 1]! > 0) {
        startLsns[i] = (startLsns[i - 1]! + lengthLsns[i - 1]!) >>> 0;
      }
    }
    if (lengthLsns[i] === 0) {
      if (i + 1 < trackCount && startLsns[i + 1]! > startLsns[i]!) {
        lengthLsns[i] = (startLsns[i + 1]! - startLsns[i]!) >>> 0;
      } else if (trackEnd > startLsns[i]!) {
        lengthLsns[i] = (trackEnd - startLsns[i]!) >>> 0;
      }
    }
  }

  return {
    trackCount,
    sampleRateHz,
    channels,
    isDst,
    startLsns,
    lengthLsns,
    durations,
    titles,
    performers,
    trackStart,
    trackEnd,
  };
}

function parseTrackText(
  area: Buffer,
  start: number,
  trackCount: number
): { titles: string[]; performers: string[] } {
  const titles = Array(trackCount).fill('');
  const performers = Array(trackCount).fill('');
  const positions = start + 8;
  for (let track = 0; track < trackCount; track++) {
    const posOff = positions + track * 2;
    if (posOff + 2 > area.length) break;
    const rel = be16(area, posOff);
    if (rel <= 0) continue;
    const textStart = start + rel;
    if (textStart >= area.length) continue;
    const nItems = area[textStart] ?? 0;
    let ptr = textStart + 4;
    for (let n = 0; n < nItems; n++) {
      if (ptr + 2 >= area.length) break;
      const type = area[ptr] ?? 0;
      ptr += 2;
      const stringStart = ptr;
      while (ptr < area.length && area[ptr] !== 0) ptr += 1;
      const text = decodeText(area.subarray(stringStart, ptr));
      if (ptr < area.length) ptr += 1;
      while (ptr < area.length && area[ptr] === 0) ptr += 1;
      if (type === 0x01) titles[track] = text;
      if (type === 0x02) performers[track] = text;
    }
  }
  return { titles, performers };
}

function readMasterText(
  fd: number,
  layout: SectorLayout
): { albumTitle: string; albumArtist: string; discTitle: string; discArtist: string } {
  for (let extra = 1; extra <= 10; extra++) {
    const sector = readSector(fd, MASTER_LSN + extra, layout);
    if (sector.subarray(0, 8).toString('ascii') === 'SACDText') {
      return {
        albumTitle: cString(sector, be16(sector, 16)),
        albumArtist: cString(sector, be16(sector, 18)),
        discTitle: cString(sector, be16(sector, 32)),
        discArtist: cString(sector, be16(sector, 34)),
      };
    }
  }
  return { albumTitle: '', albumArtist: '', discTitle: '', discArtist: '' };
}

export function listSacdTracks(filePath: string): SacdTrackInfo[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const layout = detectLayout(fd);
    const master = readSector(fd, MASTER_LSN, layout);
    const yearRaw = be16(master, 120);
    const year = yearRaw >= 1900 && yearRaw <= 2100 ? yearRaw : null;
    const stereoStart = be32(master, 64);
    const stereoSize = be16(master, 84);
    if (stereoStart <= 0 || stereoSize < 2) throw new Error('no stereo area');

    const area = Buffer.alloc(stereoSize * SECTOR);
    for (let i = 0; i < stereoSize; i++) {
      readSector(fd, stereoStart + i, layout).copy(area, i * SECTOR);
    }
    const toc = parseAreaToc(area);
    const text = readMasterText(fd, layout);
    const album = nonempty(
      text.albumTitle,
      text.discTitle,
      path.basename(filePath, path.extname(filePath))
    );
    const artist = nonempty(text.albumArtist, text.discArtist, 'Unknown Artist');

    const out: SacdTrackInfo[] = [];
    for (let i = 0; i < toc.trackCount; i++) {
      const number = i + 1;
      out.push({
        number,
        title: nonempty(toc.titles[i] ?? '', `Track ${number}`),
        artist: nonempty(toc.performers[i] ?? '', artist),
        album,
        albumArtist: artist,
        year,
        durationSecs: toc.durations[i] ?? 0,
        startLsn: toc.startLsns[i] ?? 0,
        lengthLsn: toc.lengthLsns[i] ?? 0,
        sampleRateHz: toc.sampleRateHz,
        channels: toc.channels,
        isDst: toc.isDst,
        cataloguePath: `${filePath}${SACD_MARKER}${number}`,
      });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function demuxAudioPackets(sector: Buffer): Buffer {
  if (sector.length !== SECTOR) return Buffer.alloc(0);
  const header = sector[0] ?? 0;
  const packetCount = (header >> 5) & 0x07;
  const frameInfoCount = (header >> 2) & 0x07;
  const dstEncoded = (header & 0x01) !== 0;
  let off = 1;
  const headers: Array<{ type: number; length: number }> = [];
  for (let i = 0; i < packetCount; i++) {
    if (off + 2 > sector.length) return Buffer.alloc(0);
    const b0 = sector[off] ?? 0;
    const b1 = sector[off + 1] ?? 0;
    headers.push({
      type: (b0 >> 3) & 0x07,
      length: ((b0 & 0x07) << 8) | b1,
    });
    off += 2;
  }
  off += frameInfoCount * (dstEncoded ? 4 : 3);
  if (off > sector.length) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (const h of headers) {
    if (off + h.length > sector.length) break;
    if (h.type === 2) chunks.push(sector.subarray(off, off + h.length));
    off += h.length;
  }
  return Buffer.concat(chunks);
}

function dffPreamble(sampleRate: number, channels: number): Buffer {
  const propParts: Buffer[] = [];
  propParts.push(Buffer.from('SND '));
  propParts.push(Buffer.from('FS  '));
  const fsChunk = Buffer.alloc(12);
  writeU64BE(fsChunk, 0, 4n);
  writeU32BE(fsChunk, 8, sampleRate);
  propParts.push(fsChunk);
  propParts.push(Buffer.from('CHNL'));
  const chnlSize = 2 + 4 * channels;
  const chnl = Buffer.alloc(8 + chnlSize);
  writeU64BE(chnl, 0, BigInt(chnlSize));
  writeU16BE(chnl, 8, channels);
  const ids = ['SLFT', 'SRGT', 'C   ', 'LFE ', 'LS  ', 'RS  ', 'L   ', 'R   '];
  let p = 10;
  for (let i = 0; i < channels; i++) {
    chnl.write(i < ids.length ? ids[i]! : `C${i}  `, p, 4, 'ascii');
    p += 4;
  }
  propParts.push(chnl);

  let compression = Buffer.from('DSD ');
  const name = Buffer.from('not compressed');
  compression = Buffer.concat([compression, Buffer.from([name.length]), name]);
  if (compression.length % 2 === 1) compression = Buffer.concat([compression, Buffer.from([0])]);
  propParts.push(Buffer.from('CMPR'));
  const cmprHdr = Buffer.alloc(8);
  writeU64BE(cmprHdr, 0, BigInt(compression.length));
  propParts.push(cmprHdr, compression);

  propParts.push(Buffer.from('ABSS'));
  const abss = Buffer.alloc(16);
  writeU64BE(abss, 0, 8n);
  propParts.push(abss);
  propParts.push(Buffer.from('LSCO'));
  const lsco = Buffer.alloc(10);
  writeU64BE(lsco, 0, 2n);
  writeU16BE(lsco, 8, channels === 2 ? 0 : 0xffff);
  propParts.push(lsco);

  const prop = Buffer.concat(propParts);
  const head = Buffer.alloc(36);
  head.write('FRM8', 0, 4, 'ascii');
  writeU64BE(head, 4, 0n);
  head.write('DSD ', 12, 4, 'ascii');
  head.write('FVER', 16, 4, 'ascii');
  writeU64BE(head, 20, 4n);
  writeU32BE(head, 28, 0x01050000);
  const propHdr = Buffer.alloc(12);
  propHdr.write('PROP', 0, 4, 'ascii');
  writeU64BE(propHdr, 4, BigInt(prop.length));
  const dsdHdr = Buffer.alloc(12);
  dsdHdr.write('DSD ', 0, 4, 'ascii');
  writeU64BE(dsdHdr, 4, 0n);
  return Buffer.concat([head, propHdr, prop, dsdHdr]);
}

function cachePath(filePath: string, track: number): string {
  const dir = path.join(dataDir(), 'cache', 'sacd');
  fs.mkdirSync(dir, { recursive: true });
  const mtime = fs.statSync(filePath).mtimeMs;
  const key = `${filePath}|${mtime}|${track}|dsd2`;
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(dir, `${digest}.dff`);
}

function isCurrentCache(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(20);
      fs.readSync(fd, head, 0, 20, 0);
      return head.subarray(16, 20).toString('ascii') === 'FVER';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Extract uncompressed SACD track to cached DFF. DST throws. */
export function resolveSacdPlaybackPath(cataloguePath: string): string {
  const parsed = parseSacdPath(cataloguePath);
  if (!parsed) return cataloguePath;

  const tracks = listSacdTracks(parsed.filePath);
  const discTrack = tracks.find((t) => t.number === parsed.track);
  if (!discTrack) throw new Error('SACD track not found');
  if (discTrack.isDst) {
    throw new Error('This SACD track uses DST compression (decode not available yet)');
  }
  if (discTrack.startLsn <= 0 || discTrack.lengthLsn <= 0) {
    throw new Error('Could not read DSD from this SACD track');
  }

  const out = cachePath(parsed.filePath, parsed.track);
  if (fs.existsSync(out) && fs.statSync(out).size > 128 && isCurrentCache(out)) {
    return out;
  }

  const fd = fs.openSync(parsed.filePath, 'r');
  const tmp = `${out}.part`;
  try {
    const layout = detectLayout(fd);
    const preamble = dffPreamble(discTrack.sampleRateHz, discTrack.channels);
    fs.writeFileSync(tmp, preamble);
    let dataBytes = 0n;
    const end = discTrack.startLsn + discTrack.lengthLsn;
    for (let lsn = discTrack.startLsn; lsn < end; lsn++) {
      const sector = readSector(fd, lsn, layout);
      const chunk = demuxAudioPackets(sector);
      if (chunk.length) {
        fs.appendFileSync(tmp, chunk);
        dataBytes += BigInt(chunk.length);
      }
    }
    if (dataBytes === 0n) {
      throw new Error('Could not read DSD from this SACD track');
    }
    const fileSize = BigInt(preamble.length) + dataBytes;
    const patch = Buffer.alloc(8);
    writeU64BE(patch, 0, fileSize > 12n ? fileSize - 12n : 0n);
    const fdOut = fs.openSync(tmp, 'r+');
    try {
      fs.writeSync(fdOut, patch, 0, 8, 4);
      writeU64BE(patch, 0, dataBytes);
      fs.writeSync(fdOut, patch, 0, 8, preamble.length - 8);
    } finally {
      fs.closeSync(fdOut);
    }
    fs.renameSync(tmp, out);
    return out;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}
