import fs from 'node:fs';
import net from 'node:net';
import type { Catalogue } from '../library/catalogue.js';
import {
  existingToken,
  isAuthorized,
  loadPairing,
  pairWithPin,
} from '../pairing.js';
import type { PlaybackService } from '../playback/service.js';
import type { HarborConfig } from '../types.js';
import type { Mdns } from './mdns.js';
import { toUuid, wireNowPlaying, wireQueue } from './wire.js';

const PROTOCOL_VERSION = 2;
const SERVICE_TYPE = 'audioharbor';
const MAX_FRAME = 4 << 20;

export interface BonjourRemoteOptions {
  port: number;
  name: string;
  playback: PlaybackService;
  catalogue: Catalogue;
  getConfig: () => HarborConfig;
  /** Announces `_audioharbor._tcp` on this host's `.local` name. */
  mdns: Mdns;
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
  const pairing = loadPairing();
  const serverId = pairing.serverId;

  const server = net.createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);
    let authed = false;
    let subscribed = false;
    let gen = 1;

    const sendBody = (body: unknown, id?: number) => {
      const envelope: { v: number; body: unknown; id?: number } = {
        v: PROTOCOL_VERSION,
        body,
      };
      if (id !== undefined && id !== null) envelope.id = id;
      socket.write(encodeJson(envelope));
    };

    const sendBinary = (payload: Buffer) => {
      socket.write(encodeBinary(payload));
    };

    const pushSnapshots = () => {
      if (!authed || !subscribed) return;
      gen += 1;
      sendBody({ nowPlaying: { snapshot: wireNowPlaying(opts.playback.snapshot(), gen) } });
      sendBody({ queue: { snapshot: wireQueue(opts.playback.queueSnapshot(), gen) } });
    };

    // Harbor Mac/iOS: server speaks first with unsolicited hello.
    sendBody({
      hello: {
        serverName: opts.getConfig().server.name,
        version: PROTOCOL_VERSION,
        capabilities: ['transport', 'queueJump', 'browse', 'search', 'artwork'],
        serverID: serverId,
      },
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.from(Buffer.concat([buffer, chunk]));
      const decoded = feedFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.kind !== 'json') continue;
        void handleFrame(
          frame.envelope,
          sendBody,
          sendBinary,
          () => authed,
          (v) => {
            authed = v;
          },
          () => {
            subscribed = true;
            pushSnapshots();
          },
          opts,
          serverId
        );
      }
    });

    const onUpdate = () => pushSnapshots();
    opts.playback.on('nowPlaying', onUpdate);
    opts.playback.on('queue', onUpdate);
    socket.on('close', () => {
      opts.playback.off('nowPlaying', onUpdate);
      opts.playback.off('queue', onUpdate);
    });
    socket.on('error', () => {
      /* ignore */
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '0.0.0.0', resolve));

  try {
    opts.mdns.publish({
      name: opts.name,
      type: SERVICE_TYPE,
      port: opts.port,
      txt: {
        v: String(PROTOCOL_VERSION),
        id: serverId,
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
  onSubscribe: () => void,
  opts: BonjourRemoteOptions,
  serverId: string
): Promise<void> {
  const id = envelope.id;
  const body = envelope.body ?? {};
  const keys = Object.keys(body);
  const kind = keys[0];
  const data = (kind ? body[kind] : {}) as Record<string, unknown>;

  if (kind === 'hello') {
    // Client hello with auth — respond with paired (Harbor always acks with paired).
    const auth = data.auth as { pairingCode?: string; token?: string } | undefined;
    let tokenOut: string | null = null;
    let ok = false;

    if (auth?.token) {
      tokenOut = existingToken(auth.token);
      ok = Boolean(tokenOut);
    }
    if (!ok && auth?.pairingCode) {
      tokenOut = pairWithPin(String(auth.pairingCode));
      ok = Boolean(tokenOut);
    }

    if (!ok || !tokenOut) {
      send(
        {
          error: {
            code: 'unauthorized',
            message: 'Invalid pairing code or token',
          },
        },
        id
      );
      return;
    }

    setAuthed(true);
    // Swift Decodes Data from base64 string.
    send({ paired: { token: tokenOut } }, id);
    return;
  }

  if (!isAuthed()) {
    send({ error: { code: 'unauthorized', message: 'Not paired' } }, id);
    return;
  }

  if (kind === 'ping') {
    send({ pong: true }, id);
    return;
  }

  if (kind === 'subscribe') {
    onSubscribe();
    return;
  }

  if (kind === 'transport') {
    const command = data.command as Record<string, unknown>;
    const name = Object.keys(command ?? {})[0];
    if (name === 'playPause' || name === 'toggle') {
      await opts.playback.transport({ type: 'toggle' });
    } else if (name === 'play') {
      await opts.playback.transport({ type: 'play' });
    } else if (name === 'pause') {
      await opts.playback.transport({ type: 'pause' });
    } else if (name === 'stop') {
      await opts.playback.transport({ type: 'stop' });
    } else if (name === 'next') {
      await opts.playback.transport({ type: 'next' });
    } else if (name === 'previous') {
      await opts.playback.transport({ type: 'previous' });
    } else if (name === 'seek') {
      const seconds = Number((command.seek as { seconds?: number })?.seconds ?? 0);
      await opts.playback.transport({ type: 'seek', seconds });
    } else if (name === 'setVolume') {
      const level = Number((command.setVolume as { level?: number })?.level ?? 0);
      await opts.playback.transport({ type: 'setVolume', level });
    } else if (name === 'playQueueIndex') {
      const idx = Number((command.playQueueIndex as { index?: number })?.index ?? 0);
      const q = opts.playback.queueSnapshot();
      if (q.tracks[idx]) await opts.playback.playTracks(q.tracks, idx);
    } else if (name === 'setShuffle') {
      const on = Boolean((command.setShuffle as { on?: boolean })?.on);
      await opts.playback.transport({ type: 'setShuffle', enabled: on });
    } else if (name === 'setRepeat') {
      const mode = String((command.setRepeat as { mode?: string })?.mode ?? 'off') as
        | 'off'
        | 'all'
        | 'one';
      await opts.playback.transport({ type: 'setRepeat', mode });
    }
    send({ nowPlaying: { snapshot: wireNowPlaying(opts.playback.snapshot()) } }, id);
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
        const allAlbums = opts.catalogue.albums();
        const album =
          allAlbums.find((a) => a.id === albumId) ||
          allAlbums.find((a) => toUuid(a.id) === albumId);
        if (album) await opts.playback.playTracks(opts.catalogue.albumTracks(album.id));
      }
    } else if (selection?.artist && typeof selection.artist === 'object') {
      const name = String((selection.artist as { name?: string }).name ?? '');
      if (name) await opts.playback.playTracks(opts.catalogue.artistTracks(name));
    } else if (selection?.playlist && typeof selection.playlist === 'object') {
      const playlistId = String((selection.playlist as { id?: string }).id ?? '');
      if (playlistId) {
        const pl =
          opts.catalogue.getPlaylist(playlistId) ||
          opts.catalogue.listPlaylists().find((p) => toUuid(p.id) === playlistId);
        if (pl) await opts.playback.playTracks(opts.catalogue.playlistTracks(pl.id));
      }
    } else if (selection?.label && typeof selection.label === 'object') {
      const name = String((selection.label as { name?: string }).name ?? '');
      if (name) await opts.playback.playTracks(opts.catalogue.tracksForLabel(name));
    } else if (typeof selection?.queueJump === 'number') {
      const q = opts.playback.queueSnapshot();
      const idx = selection.queueJump;
      if (q.tracks[idx]) await opts.playback.playTracks(q.tracks, idx);
    }
    send({ nowPlaying: { snapshot: wireNowPlaying(opts.playback.snapshot()) } }, id);
    return;
  }

  if (kind === 'browse') {
    const request = data.request as {
      scope?: string;
      parentID?: string;
      path?: string;
      query?: string;
      offset?: number;
      limit?: number;
    };
    const cfg = opts.getConfig();
    if (request?.query) {
      const tracks = opts.catalogue.search(request.query);
      send(
        {
          browseResult: {
            items: tracks.map((t) => ({ track: wireTrack(t) })),
            hasMore: false,
          },
        },
        id
      );
      return;
    }
    const scope = request?.scope ?? 'albums';
    const items = browseItems(opts.catalogue, cfg.library.roots, scope, request?.parentID);
    send({ browseResult: { items, hasMore: false } }, id);
    return;
  }

  if (kind === 'search') {
    send(
      {
        searchResult: {
          tracks: opts.catalogue.search(String(data.query ?? '')).map(wireTrack),
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
    const bytes = fs.readFileSync(file);
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
  void isAuthorized;
  void serverId;
}

function wireTrack(t: import('../types.js').Track): Record<string, unknown> {
  return {
    id: toUuid(t.id),
    cataloguePath: t.cataloguePath,
    title: t.title,
    artist: t.artist,
    album: t.album,
    trackNumber: t.trackNumber,
    year: t.year,
    duration: t.durationSecs ?? 0,
    format: t.format,
    sampleRateHz: t.sampleRate,
    bitDepth: t.bitDepth,
    channelCount: t.channels,
    artworkHash: t.artworkHash,
    labels: t.labels,
  };
}

function browseItems(
  catalogue: Catalogue,
  roots: string[],
  scope: string,
  parentID?: string
): unknown[] {
  if (scope === 'albums') {
    return catalogue.albums().map((a) => ({
      album: {
        id: toUuid(a.id),
        title: a.title,
        artist: a.artist,
        trackCount: a.trackCount,
        artworkHash: a.artworkHash,
      },
    }));
  }
  if (scope === 'artists') {
    return catalogue.artists().map((a) => ({
      artist: { name: a.name, trackCount: a.trackCount },
    }));
  }
  if (scope === 'albumTracks' && parentID) {
    const album =
      catalogue.albums().find((a) => toUuid(a.id) === parentID) ||
      catalogue.albums().find((a) => a.id === parentID);
    if (!album) return [];
    return catalogue.albumTracks(album.id).map((t) => ({ track: wireTrack(t) }));
  }
  if (scope === 'artistTracks' && parentID) {
    return catalogue.artistTracks(parentID).map((t) => ({ track: wireTrack(t) }));
  }
  if (scope === 'playlists') {
    return catalogue.listPlaylists().map((p) => ({
      playlist: {
        id: p.id.includes('-') ? p.id : toUuid(p.id),
        name: p.name,
        trackCount: p.paths.length,
      },
    }));
  }
  if (scope === 'playlistTracks' && parentID) {
    const pl =
      catalogue.getPlaylist(parentID) ||
      catalogue.listPlaylists().find((p) => toUuid(p.id) === parentID);
    if (!pl) return [];
    return catalogue.playlistTracks(pl.id).map((t) => ({ track: wireTrack(t) }));
  }
  if (scope === 'labels') {
    return catalogue.allLabels().map((name) => ({
      label: {
        name,
        trackCount: catalogue.tracksForLabel(name).length,
      },
    }));
  }
  if (scope === 'labelTracks' && parentID) {
    return catalogue.tracksForLabel(parentID).map((t) => ({ track: wireTrack(t) }));
  }
  if (scope === 'folders') {
    const raw = catalogue.browseFolder(roots, parentID ?? null);
    return raw.map((item) => {
      if (item.isDirectory) {
        return {
          folder: {
            id: item.path,
            name: item.name,
            childHint: null,
          },
        };
      }
      if (item.track) return { track: wireTrack(item.track) };
      return {
        folder: { id: item.path, name: item.name, childHint: null },
      };
    });
  }
  return [];
}
