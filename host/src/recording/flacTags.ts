import fs from 'node:fs';

/** One FLAC metadata block as found in the file. */
interface Block {
  type: number;
  /** Offset of the 4-byte block header. */
  offset: number;
  length: number;
}

const VORBIS_COMMENT = 4;
const PADDING = 1;

function readBlocks(fd: number): { blocks: Block[]; audioStart: number } {
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  if (magic.toString('latin1') !== 'fLaC') throw new Error('Not a FLAC file');
  const blocks: Block[] = [];
  let offset = 4;
  const head = Buffer.alloc(4);
  for (;;) {
    if (fs.readSync(fd, head, 0, 4, offset) !== 4) throw new Error('FLAC metadata cut off');
    const last = (head[0]! & 0x80) !== 0;
    const length = head.readUIntBE(1, 3);
    blocks.push({ type: head[0]! & 0x7f, offset, length });
    offset += 4 + length;
    if (last) break;
    if (blocks.length > 1024) throw new Error('FLAC metadata unreadable');
  }
  return { blocks, audioStart: offset };
}

function parseComments(data: Buffer): { vendor: string; comments: string[] } {
  let p = 0;
  const vendorLen = data.readUInt32LE(p);
  p += 4;
  const vendor = data.toString('utf8', p, p + vendorLen);
  p += vendorLen;
  const count = data.readUInt32LE(p);
  p += 4;
  const comments: string[] = [];
  for (let i = 0; i < count && p + 4 <= data.length; i += 1) {
    const len = data.readUInt32LE(p);
    p += 4;
    comments.push(data.toString('utf8', p, p + len));
    p += len;
  }
  return { vendor, comments };
}

function buildComments(vendor: string, comments: string[]): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const v = Buffer.from(vendor, 'utf8');
  parts.push(u32(v.length), v, u32(comments.length));
  for (const c of comments) {
    const b = Buffer.from(c, 'utf8');
    parts.push(u32(b.length), b);
  }
  return Buffer.concat(parts);
}

function blockHeader(type: number, length: number, last: boolean): Buffer {
  const b = Buffer.alloc(4);
  b[0] = (last ? 0x80 : 0) | type;
  b.writeUIntBE(length, 1, 3);
  return b;
}

/** The Vorbis comments of a FLAC file, keys upper case (first value of each). */
export function readFlacTags(file: string): Record<string, string> {
  const fd = fs.openSync(file, 'r');
  try {
    const { blocks } = readBlocks(fd);
    const vc = blocks.find((b) => b.type === VORBIS_COMMENT);
    if (!vc) return {};
    const data = Buffer.alloc(vc.length);
    fs.readSync(fd, data, 0, vc.length, vc.offset + 4);
    const out: Record<string, string> = {};
    for (const c of parseComments(data).comments) {
      const eq = c.indexOf('=');
      if (eq <= 0) continue;
      const key = c.slice(0, eq).toUpperCase();
      if (!(key in out)) out[key] = c.slice(eq + 1);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Sets Vorbis comments in a FLAC file (`null` removes a key); the audio frames stay untouched.
 * Written in place when the comment block and the padding after it have room (takes from the
 * recorder carry 4 KB of padding), otherwise the file is rewritten next to itself and swapped in.
 */
export async function writeFlacTags(file: string, patch: Record<string, string | null>): Promise<void> {
  const fd = fs.openSync(file, 'r+');
  let rewrite: { blocks: Block[]; audioStart: number; comments: Buffer } | null = null;
  try {
    const { blocks, audioStart } = readBlocks(fd);
    const vcIndex = blocks.findIndex((b) => b.type === VORBIS_COMMENT);
    let vendor = 'Audio Harbor';
    let comments: string[] = [];
    if (vcIndex >= 0) {
      const vc = blocks[vcIndex]!;
      const data = Buffer.alloc(vc.length);
      fs.readSync(fd, data, 0, vc.length, vc.offset + 4);
      ({ vendor, comments } = parseComments(data));
    }
    const keys = new Set(Object.keys(patch).map((k) => k.toUpperCase()));
    comments = comments.filter((c) => !keys.has(c.slice(0, Math.max(0, c.indexOf('='))).toUpperCase()));
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null) comments.push(`${key.toUpperCase()}=${value}`);
    }
    const next = buildComments(vendor, comments);

    // In place: the comment block followed directly by padding (or the same size).
    const vc = vcIndex >= 0 ? blocks[vcIndex]! : null;
    const pad = vc ? blocks[vcIndex + 1] : undefined;
    if (vc) {
      const room = vc.length + (pad?.type === PADDING ? 4 + pad.length : 0);
      const isLastBlock = vcIndex === blocks.length - 1;
      if (next.length === vc.length || (pad?.type === PADDING && room - next.length >= 4)) {
        const parts = [blockHeader(VORBIS_COMMENT, next.length, isLastBlock && next.length === vc.length), next];
        if (next.length !== vc.length) {
          const padLength = room - next.length - 4;
          const padIsLast = vcIndex + 1 === blocks.length - 1;
          parts.push(blockHeader(PADDING, padLength, padIsLast), Buffer.alloc(padLength));
        }
        const out = Buffer.concat(parts);
        fs.writeSync(fd, out, 0, out.length, vc.offset);
        return;
      }
    }
    rewrite = { blocks, audioStart, comments: next };
  } finally {
    fs.closeSync(fd);
  }

  // Rewrite: the other blocks as they are, the new comments, fresh padding, then the frames.
  const { blocks, audioStart, comments } = rewrite;
  const src = fs.openSync(file, 'r');
  const keep: Buffer[] = [];
  try {
    for (const b of blocks) {
      if (b.type === VORBIS_COMMENT || b.type === PADDING) continue;
      const data = Buffer.alloc(b.length);
      fs.readSync(src, data, 0, b.length, b.offset + 4);
      keep.push(blockHeader(b.type, b.length, false), data);
    }
  } finally {
    fs.closeSync(src);
  }
  const padding = 4096;
  const head = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    ...keep,
    blockHeader(VORBIS_COMMENT, comments.length, false),
    comments,
    blockHeader(PADDING, padding, true),
    Buffer.alloc(padding),
  ]);
  const tmp = `${file}.retag-${process.pid}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      out.on('error', reject);
      out.write(head);
      const frames = fs.createReadStream(file, { start: audioStart });
      frames.on('error', reject);
      frames.pipe(out);
      out.on('finish', () => resolve());
    });
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}
