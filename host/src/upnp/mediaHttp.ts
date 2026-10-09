import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { lanIp } from '../net.js';
import type { WavStream } from './networkMedia.js';

/** Sent with every stream; the same flags the DLNA music server uses. */
export const DLNA_FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000';

const CHUNK = 256 * 1024;

/** One stream a renderer can pull (`/t/<id>.<ext>`, artwork under `/a/`). */
export interface MediaHandle {
  path: string;
  mime: string;
}

type Route =
  | { kind: 'file'; file: string; mime: string }
  | { kind: 'wav'; wav: WavStream }
  | { kind: 'bytes'; data: Buffer; mime: string };

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` → the first range, clamped; null when it lies outside. */
export function byteRange(header: string, size: number): [number, number] | null {
  if (size <= 0 || !header.toLowerCase().startsWith('bytes=')) return null;
  const spec = header.slice(6).split(',')[0]!.trim();
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const a = spec.slice(0, dash).trim();
  const b = spec.slice(dash + 1).trim();
  if (!a) {
    const suffix = Number(b);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return [size - Math.min(suffix, size), size - 1];
  }
  const start = Number(a);
  if (!Number.isInteger(start) || start >= size) return null;
  const end = b ? Math.min(Number(b), size - 1) : size - 1;
  return Number.isInteger(end) && end >= start ? [start, end] : null;
}

const towardCache = new Map<string, { address: string; at: number }>();

/** This host's IPv4 address on the route toward `host` — the one `host` can reach. */
export async function localAddressToward(host: string): Promise<string> {
  const hit = towardCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.address;
  const socket = dgram.createSocket('udp4');
  try {
    const address = await new Promise<string>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(1900, host, () => resolve(socket.address().address));
    });
    towardCache.set(host, { address, at: Date.now() });
    return address;
  } catch {
    return lanIp();
  } finally {
    socket.close();
  }
}

/**
 * Serves track files and generated WAV to network players: opaque tokens, `Range` / `HEAD`,
 * DLNA streaming headers, bodies paced by the reader. URLs carry this host's address toward
 * the renderer.
 */
export class MediaHttpServer {
  port = 0;
  lastError: string | null = null;

  private server: http.Server | null = null;
  private starting: Promise<void> | null = null;
  private routes = new Map<string, Route>();
  private counter = 0;

  constructor(private preferredPort: number) {}

  get isRunning(): boolean {
    return this.port > 0;
  }

  /** Listens on the preferred port, or on any free one when that is taken. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      for (const port of [this.preferredPort, 0]) {
        try {
          await new Promise<void>((resolve, reject) => {
            const fail = (err: Error) => reject(err);
            server.once('error', fail);
            server.listen(port, '0.0.0.0', () => {
              server.off('error', fail);
              resolve();
            });
          });
          const address = server.address();
          this.port = typeof address === 'object' && address ? address.port : port;
          this.server = server;
          this.lastError = null;
          if (port === 0 && this.preferredPort !== 0) {
            console.warn(`Media HTTP: port ${this.preferredPort} is taken, using ${this.port}`);
          }
          return;
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }
      throw new Error(`Media HTTP server failed: ${this.lastError ?? 'no port'}`);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  registerFile(file: string, mime: string): MediaHandle {
    const path = this.nextPath('/t/', extensionFor(mime, file));
    this.routes.set(path, { kind: 'file', file, mime });
    return { path, mime };
  }

  registerWav(wav: WavStream): MediaHandle {
    const path = this.nextPath('/t/', 'wav');
    this.routes.set(path, { kind: 'wav', wav });
    return { path, mime: 'audio/wav' };
  }

  registerArtwork(data: Buffer): MediaHandle {
    const png = data.length > 8 && data[0] === 0x89 && data[1] === 0x50;
    const mime = png ? 'image/png' : 'image/jpeg';
    const path = this.nextPath('/a/', png ? 'png' : 'jpg');
    this.routes.set(path, { kind: 'bytes', data, mime });
    return { path, mime };
  }

  unregister(handle: MediaHandle | null | undefined): void {
    if (!handle) return;
    const route = this.routes.get(handle.path);
    this.routes.delete(handle.path);
    if (route?.kind === 'wav') route.wav.close();
  }

  /** Absolute URL the renderer at `peerHost` can reach. */
  async urlFor(handle: MediaHandle, peerHost: string): Promise<string> {
    await this.start();
    return `http://${await localAddressToward(peerHost)}:${this.port}${handle.path}`;
  }

  private nextPath(prefix: string, ext: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0]!;
    const route = this.routes.get(path);
    if (!route) {
      res.writeHead(404).end();
      return;
    }

    let size: number;
    let mime: string;
    if (route.kind === 'file') {
      try {
        size = (await fs.promises.stat(route.file)).size;
      } catch {
        res.writeHead(404).end();
        return;
      }
      mime = route.mime;
    } else if (route.kind === 'wav') {
      size = route.wav.totalSize;
      mime = 'audio/wav';
    } else {
      size = route.data.length;
      mime = route.mime;
    }

    const headers: Record<string, string | number> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'transferMode.dlna.org': route.kind === 'bytes' ? 'Interactive' : 'Streaming',
      'contentFeatures.dlna.org': DLNA_FEATURES,
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const range = byteRange(rangeHeader, size);
      if (!range) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      [start, end] = range;
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (method === 'HEAD' || size === 0) {
      res.end();
      return;
    }

    try {
      if (route.kind === 'bytes') {
        res.end(route.data.subarray(start, end + 1));
      } else if (route.kind === 'file') {
        await pipeline(fs.createReadStream(route.file, { start, end, highWaterMark: CHUNK }), res);
      } else {
        await pipeline(Readable.from(wavChunks(route.wav, start, end + 1)), res);
      }
    } catch {
      // The player hung up — it seeks with a new request, or stopped.
      res.destroy();
    }
  }
}

/** Generated WAV bytes [start, end), pulled as the socket drains. */
async function* wavChunks(wav: WavStream, start: number, end: number): AsyncGenerator<Buffer> {
  let offset = start;
  while (offset < end) {
    const chunk = await wav.read(offset, Math.min(CHUNK, end - offset));
    // Closed underneath (the track changed): drop the connection, it promised more.
    if (!chunk.length) throw new Error('stream closed');
    offset += chunk.length;
    yield chunk;
  }
}

function extensionFor(mime: string, file: string): string {
  switch (mime) {
    case 'audio/flac':
      return 'flac';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/wav':
      return 'wav';
    case 'audio/aiff':
      return 'aiff';
    case 'audio/mpeg':
      return 'mp3';
    default: {
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin';
    }
  }
}
