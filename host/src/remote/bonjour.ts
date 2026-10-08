import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import type { Catalogue } from '../library/catalogue.js';
import type { PlaybackService } from '../playback/service.js';
import { isAuthorized, loadPairing, pairWithPin } from '../pairing.js';
import type { HarborConfig } from '../types.js';

const PROTOCOL_VERSION = 2;
const SERVICE_TYPE = 'audioharbor';
const MAX_FRAME = 4 << 20;

export interface BonjourRemoteOptions {
  port: number;
  name: string;
  playback: PlaybackService;
  catalogue: Catalogue;
  getConfig: () => HarborConfig;
}

/** Harbor FrameCodec: `[u32be length][kind][payload]` — kind 0=JSON, 1=binary. */
function encodeJson(envelope: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(1 + payload.length, 0);
  header[4] = 0;
  return Buffer.concat([header, payload]);
}

function encodeBinary(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(1 + payload.length, 0);
  header[4] = 1;
  return Buffer.concat([header, payload]);
}

type Decoded =
  | { kind: 'json'; envelope: { v?: number; id?: number; body?: Record<string, unknown> } }
  | { kind: 'binary'; payload: Buffer };

function feedFrames(buffer: Buffer): { frames: Decoded[]; rest: Buffer } {
  const frames: Decoded[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (length < 1 || length > MAX_FRAME) break;
    const total = 4 + length;
    if (buffer.length - offset < total) break;
    const kind = buffer[offset + 4];
    const payload = buffer.subarray(offset + 5, offset + total);
    offset += total;
    if (kind === 0) {
      try {
        frames.push({ kind: 'json', envelope: JSON.parse(payload.toString('utf8')) });
      } catch {
        /* skip bad json */
      }
    } else if (kind === 1) {
      frames.push({ kind: 'binary', payload: Buffer.from(payload) });
    }
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}

export async function startBonjourRemote(opts: BonjourRemoteOptions): Promise<void> {
  const serverId = randomUUID();

  const server = net.createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    let authed = false;

    const sendBody = (body: unknown, id?: number) => {
      socket.write(encodeJson({ v: PROTOCOL_VERSION, id, body }));
    };

    const sendBinary = (payload: Buffer) => {
      socket.write(encodeBinary(payload));
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.from(Buffer.concat([buffer, chunk]));
      const decoded = feedFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.kind !== 'json') continue;
        void handleFrame(frame.envelope, sendBody, sendBinary, () => authed, (v) => {
          authed = v;
        }, opts, serverId);
      }
    });

    const push = () => {
      if (!authed) return;
      sendBody({ nowPlaying: { snapshot: opts.playback.snapshot() } });
      sendBody({ queue: { snapshot: opts.playback.queueSnapshot() } });
    };
    opts.playback.on('nowPlaying', push);
    opts.playback.on('queue', push);
    socket.on('close', () => {
      opts.playback.off('nowPlaying', push);
      opts.playback.off('queue', push);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '0.0.0.0', resolve));

  try {
    const bonjour = new Bonjour();
    bonjour.publish({
      name: opts.name,
      type: SERVICE_TYPE,
      port: opts.port,
      txt: {
        v: String(PROTOCOL_VERSION),
        caps: 'transport,queueJump,browse,search,artwork',
      },
    });
  } catch (err) {
    console.warn('Bonjour publish failed:', err);
  }
}

async function handleFrame(
  envelope: { v?: number; id?: number; body?: Record<string, unknown> },
  send: (body: unknown, id?: number) => void,
  sendBinary: (payload: Buffer) => void,
  isAuthed: () => boolean,
  setAuthed: (v: boolean) => void,
  opts: BonjourRemoteOptions,
  serverId: string
): Promise<void> {
  const id = envelope.id;
  const body = envelope.body ?? {};
  const keys = Object.keys(body);
  const kind = keys[0];
  const data = (kind ? body[kind] : {}) as Record<string, unknown>;

  if (kind === 'hello') {
    const auth = data.auth as { pairingCode?: string; token?: string } | undefined;
    let tokenOut: string | null = null;
    let ok = false;
    if (auth?.token && isAuthorized(auth.token)) ok = true;
    if (auth?.pairingCode) {
      tokenOut = pairWithPin(auth.pairingCode);
      ok = Boolean(tokenOut);
    }
    if (!ok) {
      send({ error: { code: 'unauthorized', message: 'pairing required' } }, id);
      return;
    }
    setAuthed(true);
    send(
      {
        hello: {
          serverName: opts.getConfig().server.name,
          version: PROTOCOL_VERSION,
          capabilities: ['transport', 'queueJump', 'browse', 'search', 'artwork'],
          serverID: serverId,
        },
      },
      id
    );
    if (tokenOut) {
      // Harbor uses Data; send base64 string for JSON wire
      send({ paired: { token: Buffer.from(tokenOut).toString('base64') } });
    }
    send({ nowPlaying: { snapshot: opts.playback.snapshot() } });
    send({ queue: { snapshot: opts.playback.queueSnapshot() } });
    return;
  }

  if (!isAuthed()) {
    send({ error: { code: 'unauthorized', message: 'not paired' } }, id);
    return;
  }

  if (kind === 'ping') {
    send({ pong: true }, id);
    return;
  }

  if (kind === 'subscribe') {
    send({ nowPlaying: { snapshot: opts.playback.snapshot() } }, id);
    send({ queue: { snapshot: opts.playback.queueSnapshot() } });
    return;
  }

  if (kind === 'transport') {
    const command = data.command as Record<string, unknown>;
    const name = Object.keys(command ?? {})[0];
    if (name === 'play') await opts.playback.transport({ type: 'play' });
    if (name === 'pause') await opts.playback.transport({ type: 'pause' });
    if (name === 'toggle') await opts.playback.transport({ type: 'toggle' });
    if (name === 'stop') await opts.playback.transport({ type: 'stop' });
    if (name === 'next') await opts.playback.transport({ type: 'next' });
    if (name === 'previous') await opts.playback.transport({ type: 'previous' });
    if (name === 'seek') {
      const seconds = Number((command.seek as { seconds?: number })?.seconds ?? 0);
      await opts.playback.transport({ type: 'seek', seconds });
    }
    if (name === 'setVolume') {
      const level = Number((command.setVolume as { level?: number })?.level ?? 0);
      await opts.playback.transport({ type: 'setVolume', level });
    }
    send({ nowPlaying: { snapshot: opts.playback.snapshot() } }, id);
    return;
  }

  if (kind === 'playSelection') {
    const selection = data.selection as Record<string, unknown>;
    if (selection?.track && typeof selection.track === 'object') {
      const cataloguePath = String(
        (selection.track as { cataloguePath?: string }).cataloguePath ?? ''
      );
      if (cataloguePath) await opts.playback.playTrack(cataloguePath);
    } else if (selection?.album && typeof selection.album === 'object') {
      const albumId = String((selection.album as { id?: string }).id ?? '');
      if (albumId) {
        await opts.playback.playTracks(opts.catalogue.albumTracks(albumId));
      }
    } else if (typeof selection?.queueJump === 'number') {
      const q = opts.playback.queueSnapshot();
      const idx = selection.queueJump;
      if (q.tracks[idx]) await opts.playback.playTracks(q.tracks, idx);
    }
    send({ nowPlaying: { snapshot: opts.playback.snapshot() } }, id);
    return;
  }

  if (kind === 'browse') {
    const request = data.request as { scope?: string; path?: string; query?: string };
    const cfg = opts.getConfig();
    if (request?.query) {
      send(
        {
          browseResult: {
            items: opts.catalogue.search(request.query).map((t) => ({ track: t })),
            hasMore: false,
          },
        },
        id
      );
      return;
    }
    const scope = (request?.scope ?? 'albums') as 'folders' | 'albums' | 'artists';
    const raw = opts.catalogue.browse(scope, cfg.library.roots, request?.path);
    send({ browseResult: { items: raw, hasMore: false } }, id);
    return;
  }

  if (kind === 'search') {
    send(
      {
        searchResult: {
          tracks: opts.catalogue.search(String(data.query ?? '')),
        },
      },
      id
    );
    return;
  }

  if (kind === 'artwork') {
    const hash = String(data.hash ?? '');
    const file = opts.catalogue.artworkFile(hash);
    if (!file || !fs.existsSync(file)) {
      send({ error: { code: 'notFound', message: 'artwork' } }, id);
      return;
    }
    let bytes = fs.readFileSync(file);
    const maxPixel = Number(data.maxPixel ?? 0);
    // Keep original; client scales. Cap payload size for LAN.
    if (bytes.length > 512 * 1024) bytes = bytes.subarray(0, 512 * 1024);
    send({ artworkHeader: { hash, byteCount: bytes.length } }, id);
    sendBinary(bytes);
    return;
  }

  if (kind === 'trackOptions') {
    const cataloguePath = String(data.cataloguePath ?? '');
    const options = opts.catalogue.trackOptions(cataloguePath);
    if (!options) {
      send({ error: { code: 'notFound', message: 'track' } }, id);
      return;
    }
    send({ trackOptions: { options } }, id);
    return;
  }

  if (kind === 'editTrack') {
    const cataloguePath = String(data.cataloguePath ?? '');
    const edit = data.edit as Record<string, unknown>;
    try {
      opts.catalogue.applyTrackEdit(cataloguePath, edit);
      const options = opts.catalogue.trackOptions(cataloguePath);
      send({ trackOptions: { options } }, id);
    } catch (err) {
      send(
        {
          error: {
            code: 'badRequest',
            message: err instanceof Error ? err.message : 'edit failed',
          },
        },
        id
      );
    }
    return;
  }

  send({ error: { code: 'unsupported', message: kind ?? 'unknown' } }, id);
}

void loadPairing;
