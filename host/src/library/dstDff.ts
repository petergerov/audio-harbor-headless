import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { engineDstBegin, engineDstDecodeFrame, engineDstEnd } from '../engine/bridge.js';
import { dataDir } from '../paths.js';

const YIELD_EVERY_FRAMES = 8;

function writeU16BE(buf: Buffer, off: number, v: number): void {
  buf.writeUInt16BE(v & 0xffff, off);
}
function writeU32BE(buf: Buffer, off: number, v: number): void {
  buf.writeUInt32BE(v >>> 0, off);
}
function writeU64BE(buf: Buffer, off: number, v: bigint): void {
  buf.writeBigUInt64BE(v, off);
}
function be64(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64BE(off);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Quick check: PROP CMPR is not plain DSD, or a top-level DST chunk is present. */
export function isDstCompressedDff(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(16);
      if (fs.readSync(fd, head, 0, 16, 0) < 16) return false;
      if (head.subarray(0, 4).toString('ascii') !== 'FRM8') return false;
      if (head.subarray(12, 16).toString('ascii') !== 'DSD ') return false;
      const st = fs.fstatSync(fd);
      let pos = 16;
      const chunk = Buffer.alloc(12);
      while (pos + 12 <= st.size) {
        if (fs.readSync(fd, chunk, 0, 12, pos) < 12) break;
        const id = chunk.subarray(0, 4).toString('ascii');
        const size = Number(be64(chunk, 4));
        const body = pos + 12;
        if (id === 'PROP') {
          const prop = Buffer.alloc(Math.min(size, 1 << 20));
          fs.readSync(fd, prop, 0, prop.length, body);
          let p = 4; // skip "SND "
          while (p + 12 <= prop.length) {
            const subId = prop.subarray(p, p + 4).toString('ascii');
            const sub = Number(be64(prop, p + 4));
            const subBody = p + 12;
            if (subId === 'CMPR' && subBody + 4 <= prop.length) {
              const cmpr = prop.subarray(subBody, subBody + 4).toString('ascii');
              return cmpr !== 'DSD ';
            }
            p = subBody + sub + (sub & 1);
          }
        } else if (id === 'DST ') {
          return true;
        } else if (id === 'DSD ') {
          return false;
        }
        pos = body + size + (size & 1);
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

interface DstDffLayout {
  sampleRate: number;
  channels: number;
  dstBody: number;
  dstEnd: number;
}

function readLayout(fd: number, fileSize: number): DstDffLayout {
  let sampleRate = 0;
  let channels = 0;
  let dstBody = 0;
  let dstEnd = 0;
  let pos = 16;
  const chunk = Buffer.alloc(12);
  while (pos + 12 <= fileSize) {
    if (fs.readSync(fd, chunk, 0, 12, pos) < 12) break;
    const id = chunk.subarray(0, 4).toString('ascii');
    const size = Number(be64(chunk, 4));
    const body = pos + 12;
    if (id === 'PROP') {
      const prop = Buffer.alloc(Math.min(size, 1 << 20));
      fs.readSync(fd, prop, 0, prop.length, body);
      let p = 4;
      while (p + 12 <= prop.length) {
        const subId = prop.subarray(p, p + 4).toString('ascii');
        const sub = Number(be64(prop, p + 4));
        const subBody = p + 12;
        if (subId === 'FS  ' && subBody + 4 <= prop.length) {
          sampleRate = prop.readUInt32BE(subBody);
        } else if (subId === 'CHNL' && subBody + 2 <= prop.length) {
          channels = prop.readUInt16BE(subBody);
        }
        p = subBody + sub + (sub & 1);
      }
    } else if (id === 'DST ') {
      dstBody = body;
      dstEnd = body + size;
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!dstBody || !sampleRate || !channels) {
    throw new Error('DST-compressed DFF is missing DST data or format');
  }
  return { sampleRate, channels, dstBody, dstEnd };
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
  const head = Buffer.alloc(32);
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

function cacheFile(filePath: string): string {
  const dir = path.join(dataDir(), 'cache', 'dst-dff');
  fs.mkdirSync(dir, { recursive: true });
  const mtime = fs.statSync(filePath).mtimeMs;
  const key = `${filePath}|${mtime}|dst1`;
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(dir, `${digest}.dff`);
}

function isWarmCache(out: string): boolean {
  try {
    if (!fs.existsSync(out) || fs.statSync(out).size <= 128) return false;
    const fd = fs.openSync(out, 'r');
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

function finalizeDff(tmp: string, out: string, preambleLen: number, dataBytes: bigint): void {
  if (dataBytes === 0n) throw new Error('DST-compressed DFF produced no audio');
  const fileSize = BigInt(preambleLen) + dataBytes;
  const patch = Buffer.alloc(8);
  writeU64BE(patch, 0, fileSize > 12n ? fileSize - 12n : 0n);
  const fdOut = fs.openSync(tmp, 'r+');
  try {
    fs.writeSync(fdOut, patch, 0, 8, 4);
    writeU64BE(patch, 0, dataBytes);
    fs.writeSync(fdOut, patch, 0, 8, preambleLen - 8);
  } finally {
    fs.closeSync(fdOut);
  }
  fs.renameSync(tmp, out);
}

const extracting = new Map<string, Promise<string>>();

/**
 * Decode a DST-compressed `.dff` to an uncompressed DFF in the cache (same idea as SACD).
 * Plain DFF / non-DFF paths are returned unchanged.
 */
export async function resolveDstDffPlaybackPath(filePath: string): Promise<string> {
  if (path.extname(filePath).toLowerCase() !== '.dff') return filePath;
  if (!isDstCompressedDff(filePath)) return filePath;

  const out = cacheFile(filePath);
  if (isWarmCache(out)) return out;
  const running = extracting.get(out);
  if (running) return running;
  const job = extractDstDff(filePath, out).finally(() => extracting.delete(out));
  extracting.set(out, job);
  return job;
}

async function extractDstDff(filePath: string, out: string): Promise<string> {
  const fd = fs.openSync(filePath, 'r');
  const tmp = `${out}.part`;
  let session: unknown = null;
  try {
    const fileSize = fs.fstatSync(fd).size;
    const layout = readLayout(fd, fileSize);
    const preamble = dffPreamble(layout.sampleRate, layout.channels);
    const outFd = fs.openSync(tmp, 'w');
    let dataBytes = 0n;
    try {
      fs.writeSync(outFd, preamble);
      session = engineDstBegin(layout.sampleRate, layout.channels);
      const hdr = Buffer.alloc(12);
      let pos = layout.dstBody;
      let frames = 0;
      while (pos + 12 <= layout.dstEnd) {
        if (fs.readSync(fd, hdr, 0, 12, pos) < 12) break;
        const id = hdr.subarray(0, 4).toString('ascii');
        const size = Number(be64(hdr, 4));
        const body = pos + 12;
        if (id === 'DSTF') {
          const frame = Buffer.alloc(size);
          if (size > 0) fs.readSync(fd, frame, 0, size, body);
          const dsd = engineDstDecodeFrame(session, frame);
          if (dsd.length) {
            fs.writeSync(outFd, dsd);
            dataBytes += BigInt(dsd.length);
          }
          frames += 1;
          if (frames % YIELD_EVERY_FRAMES === 0) await yieldToEventLoop();
        }
        // FRTE, DSTC, and anything else: skip.
        pos = body + size + (size & 1);
      }
    } finally {
      fs.closeSync(outFd);
    }
    finalizeDff(tmp, out, preamble.length, dataBytes);
    return out;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    if (session) engineDstEnd(session);
    fs.closeSync(fd);
  }
}
