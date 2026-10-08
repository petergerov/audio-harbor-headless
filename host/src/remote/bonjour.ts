import net from 'node:net';
import { Bonjour } from 'bonjour-service';
import type { Catalogue } from '../library/catalogue.js';
import type { PlaybackService } from '../playback/service.js';
import { isAuthorized, loadPairing, pairWithPin } from '../pairing.js';
import type { HarborConfig } from '../types.js';

const PROTOCOL_VERSION = 2;
const SERVICE_TYPE = 'audioharbor';

export interface BonjourRemoteOptions {
  port: number;
  name: string;
  playback: PlaybackService;
  catalogue: Catalogue;
  getConfig: () => HarborConfig;
}

/**
 * Audio Harbor remote protocol v2 (length-prefixed JSON frames) over TCP,
 * advertised as `_audioharbor._tcp` for the existing iOS remote.
 */
export async function startBonjourRemote(opts: BonjourRemoteOptions): Promise<void> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;

    const send = (body: unknown, id?: number) => {
      const envelope = { v: PROTOCOL_VERSION, id, body };
      const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) break;
        const frame = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        void handleFrame(frame, send, () => authed, (v) => {
          authed = v;
        }, opts);
      }
    });

    const push = () => {
      if (!authed) return;
      send({ nowPlaying: opts.playback.snapshot() });
      send({ queue: opts.playback.queueSnapshot() });
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
  frame: Buffer,
  send: (body: unknown, id?: number) => void,
  isAuthed: () => boolean,
  setAuthed: (v: boolean) => void,
  opts: BonjourRemoteOptions
): Promise<void> {
  let envelope: { v?: number; id?: number; body?: Record<string, unknown> };
  try {
    envelope = JSON.parse(frame.toString('utf8'));
  } catch {
    return;
  }
  const id = envelope.id;
  const body = envelope.body ?? {};
  const keys = Object.keys(body);
  const kind = keys[0];
  const data = kind ? (body[kind] as Record<string, unknown>) : {};

  if (kind === 'hello') {
    const auth = data.auth as { pairingCode?: string; token?: string } | undefined;
    let ok = false;
    if (auth?.token && isAuthorized(auth.token)) ok = true;
    if (auth?.pairingCode) {
      const token = pairWithPin(auth.pairingCode);
      if (token) {
        ok = true;
        setAuthed(true);
        send(
          {
            welcome: {
              serverName: opts.getConfig().server.name,
              version: PROTOCOL_VERSION,
              token,
              capabilities: ['transport', 'queueJump', 'browse', 'search', 'artwork'],
            },
          },
          id
        );
        send({ nowPlaying: opts.playback.snapshot() });
        return;
      }
    }
    if (ok) {
      setAuthed(true);
      send(
        {
          welcome: {
            serverName: opts.getConfig().server.name,
            version: PROTOCOL_VERSION,
            capabilities: ['transport', 'queueJump', 'browse', 'search', 'artwork'],
          },
        },
        id
      );
      send({ nowPlaying: opts.playback.snapshot() });
      return;
    }
    send({ error: { code: 'unauthorized', message: 'pairing required' } }, id);
    return;
  }

  if (!isAuthed()) {
    send({ error: { code: 'unauthorized', message: 'not paired' } }, id);
    return;
  }

  if (kind === 'ping') {
    send({ pong: {} }, id);
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
    send({ ok: true }, id);
    return;
  }

  if (kind === 'playSelection') {
    const selection = data.selection as Record<string, unknown>;
    if (selection?.track && typeof selection.track === 'object') {
      const cataloguePath = String((selection.track as { cataloguePath?: string }).cataloguePath ?? '');
      if (cataloguePath) await opts.playback.playTrack(cataloguePath);
    }
    send({ ok: true }, id);
    return;
  }

  if (kind === 'browse') {
    const request = data.request as { scope?: string; path?: string; query?: string };
    const cfg = opts.getConfig();
    if (request?.query) {
      send({ browseResult: { items: opts.catalogue.search(request.query) } }, id);
      return;
    }
    const scope = (request?.scope ?? 'albums') as 'folders' | 'albums' | 'artists';
    send(
      {
        browseResult: {
          items: opts.catalogue.browse(scope, cfg.library.roots, request?.path),
        },
      },
      id
    );
    return;
  }

  if (kind === 'search') {
    send({ searchResult: { items: opts.catalogue.search(String(data.query ?? '')) } }, id);
    return;
  }

  send({ error: { code: 'unsupported', message: kind ?? 'unknown' } }, id);
}

// silence unused import when pairing store only used via helpers
void loadPairing;
