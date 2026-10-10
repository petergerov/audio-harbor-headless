import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { artworkDir } from '../paths.js';

const run = promisify(execFile);

/** Room for the bytes in one frame: its length covers the kind byte too. */
const MAX_BYTES = (4 << 20) - 1;
/** What a cover too big for a frame is scaled to. */
const FALLBACK_PIXELS = 2048;
const SCALE_TIMEOUT_MS = 15_000;

/** Pixel size of a JPEG or PNG from its header; null for anything else. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    // Start of frame (not DHT / JPG / DAC, which share the range): height, then width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
}

/**
 * A cover for the remote: no larger than `maxPixel` on its longest side (0 or 4096 and up: as
 * stored), and small enough for one frame; null when it cannot be. Scaled copies are kept under
 * `artwork/scaled`. Scaling uses `sips` on macOS and `ffmpeg` elsewhere; without them the
 * stored cover goes out when it fits.
 */
export async function remoteArtwork(file: string, hash: string, maxPixel: number): Promise<Buffer | null> {
  const original = await fs.promises.readFile(file);
  let bytes: Buffer = original;
  if (maxPixel > 0 && maxPixel < 4096) bytes = (await scaled(original, file, hash, maxPixel)) ?? original;
  if (bytes.length > MAX_BYTES) bytes = (await scaled(original, file, hash, FALLBACK_PIXELS)) ?? bytes;
  return bytes.length <= MAX_BYTES ? bytes : null;
}

async function scaled(original: Buffer, file: string, hash: string, maxPixel: number): Promise<Buffer | null> {
  const size = imageSize(original);
  if (!size) return null;
  const longest = Math.max(size.width, size.height);
  if (longest <= maxPixel) return original;
  const width = Math.max(1, Math.floor((size.width * maxPixel) / longest));
  const height = Math.max(1, Math.floor((size.height * maxPixel) / longest));
  const dir = path.join(artworkDir(), 'scaled');
  const out = path.join(dir, `${hash}-${maxPixel}.jpg`);
  try {
    return await fs.promises.readFile(out);
  } catch {
    // Not scaled to this size yet.
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${hash}-${maxPixel}.${process.pid}-${Date.now()}.jpg`);
  try {
    if (process.platform === 'darwin') {
      await run(
        'sips',
        ['-z', String(height), String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', file, '--out', tmp],
        { timeout: SCALE_TIMEOUT_MS }
      );
    } else {
      // image2pipe probes the content: a PNG cover is stored under .jpg too.
      await run(
        'ffmpeg',
        ['-v', 'error', '-y', '-f', 'image2pipe', '-i', file, '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-update', '1', '-q:v', '3', tmp],
        { timeout: SCALE_TIMEOUT_MS }
      );
    }
    await fs.promises.rename(tmp, out);
    return await fs.promises.readFile(out);
  } catch {
    await fs.promises.rm(tmp, { force: true });
    return null;
  }
}
