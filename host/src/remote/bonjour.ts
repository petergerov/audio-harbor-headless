import net from 'node:net';
import type { Catalogue } from '../library/catalogue.js';
import { existingToken, loadPairing, pairingLockedOut, pairWithPin } from '../pairing.js';
import { isRepeatMode, type PlaybackService } from '../playback/service.js';
import type { HarborConfig, NowPlayingSnapshot, QueueSnapshot } from '../types.js';
import { remoteArtwork } from './artwork.js';
import { browseLibrary, findPlaylist, resolveSelection, type BrowseRequest } from './browse.js';
import type { Mdns } from './mdns.js';
import type { RemoteSettings, SettingsSnapshot } from './settings.js';
import { trackDto, wireNowPlaying, wirePlaylistId, wireQueue } from './wire.js';

const PROTOCOL_VERSION = 3;
const SERVICE_TYPE = 'audioharbor';
const MAX_FRAME = 4 << 20;
const CAPABILITIES = ['transport', 'queueJump', 'browse', 'search', 'artwork'];
const TOPICS = ['nowPlaying', 'queue', 'settings'] as const;
type Topic = (typeof TOPICS)[number];

export interface BonjourRemoteOptions {
  port: number;
  name: string;
  playback: PlaybackService;
  catalogue: Catalogue;
  settings: RemoteSettings;
  getConfig: () => HarborConfig;
  /** Announces `_audioharbor._tcp` on this host's `.local` name. */
  mdns: Mdns;
}

interface Envelope {
  v?: number;
  id?: number;
  body?: Record<string, unknown>;
}

type Fields = Record<string, unknown>;

/** Harbor FrameCodec: `[u32be length][kind][payload]` — kind 0=JSON, 1=binary. */
function frame(kind: 0 | 1, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(1 + payload.length, 0);
  header[4] = kind;
  return Buffer.concat([header, payload]);
}

function fields(value: unknown): Fields {
  return value && typeof value === 'object' ? (value as Fields) : {};
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One connection: pairs, routes commands, pushes the topics it subscribed to. */
class RemoteSession {
  private buffer: Buffer = Buffer.alloc(0);
  private authed = false;
  private topics = new Set<Topic>();
  private generation = 0;
  /** The settings this client was sent last; a push that repeats them is skipped. */
  private lastSettings = '';

  constructor(
    private readonly socket: net.Socket,
    private readonly opts: BonjourRemoteOptions,
    private readonly serverId: string
  ) {}

  start(): void {
    const { playback, settings } = this.opts;
    const onNowPlaying = (snapshot: NowPlayingSnapshot) => {
      if (this.topics.has('nowPlaying')) this.pushNowPlaying(snapshot);
    };
    const onQueue = (snapshot: QueueSnapshot) => {
      if (this.topics.has('queue')) this.pushQueue(snapshot);
    };
    playback.on('nowPlaying', onNowPlaying);
    playback.on('queue', onQueue);
    const unwatch = settings.watch((snapshot) => {
      if (this.topics.has('settings')) this.sendSettings(snapshot);
    });
    this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
    this.socket.on('close', () => {
      playback.off('nowPlaying', onNowPlaying);
      playback.off('queue', onQueue);
      unwatch();
    });
    this.socket.on('error', () => undefined);

    // Harbor Mac/iOS: the server speaks first.
    this.send({
      hello: {
        serverName: this.opts.getConfig().server.name,
        version: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverID: this.serverId,
      },
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const length = this.buffer.readUInt32BE(offset);
      if (length < 1 || length > MAX_FRAME) {
        // The framing is lost; nothing after this can be read.
        this.error('badRequest', `Invalid frame length ${length}`);
        this.buffer = Buffer.alloc(0);
        this.socket.end();
        return;
      }
      const total = 4 + length;
      if (this.buffer.length - offset < total) break;
      const kind = this.buffer[offset + 4];
      const payload = this.buffer.subarray(offset + 5, offset + total);
      offset += total;
      if (kind !== 0) continue;
      let envelope: Envelope | null = null;
      try {
        envelope = JSON.parse(payload.toString('utf8')) as Envelope;
      } catch {
        // Not JSON: refused below like a request this host does not know.
      }
      if (!envelope || typeof envelope !== 'object') {
        this.error('unsupported', 'This host does not support that request');
        continue;
      }
      const id = typeof envelope.id === 'number' ? envelope.id : undefined;
      void this.handle(fields(envelope.body), id).catch((err) => this.error('internalError', message(err), id));
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
  }

  private async handle(body: Fields, id: number | undefined): Promise<void> {
    const kind = Object.keys(body)[0];
    const data = fields(kind ? body[kind] : undefined);
    if (kind === 'hello') return this.hello(data, id);
    if (!this.authed) return this.error('unauthorized', 'Not paired', id);

    const { playback, catalogue, settings, getConfig } = this.opts;
    switch (kind) {
      case 'ping':
        return this.send({ pong: true }, id);
      case 'subscribe':
        return this.subscribe(data);
      case 'transport':
        return this.transport(fields(data.command), id);
      case 'playSelection':
        return this.playSelection(fields(data.selection), id);
      case 'browse':
        return this.send(
          { browseResult: browseLibrary(catalogue, getConfig().library.roots, fields(data.request) as BrowseRequest) },
          id
        );
      case 'search': {
        const query = String(data.query ?? '').trim();
        const limit = Math.min(Math.max(1, Math.floor(Number(data.limit) || 50)), 500);
        const tracks = query ? catalogue.search(query, limit) : [];
        return this.send({ searchResult: { tracks: tracks.map(trackDto) } }, id);
      }
      case 'artwork':
        return this.artwork(String(data.hash ?? ''), Math.floor(Number(data.maxPixel) || 0), id);
      case 'trackOptions':
        return this.trackOptions(String(data.cataloguePath ?? ''), id);
      case 'editTrack':
        return this.editTrack(String(data.cataloguePath ?? ''), fields(data.edit), id);
      case 'getSettings':
        return this.sendSettings(settings.snapshot(), id);
      case 'setSettings': {
        const failure = await settings.apply(data.patch);
        if (failure) return this.error('badRequest', failure, id);
        return this.sendSettings(settings.snapshot(), id);
      }
      default:
        return this.error('unsupported', 'This host does not support that request', id);
    }
  }

  private hello(data: Fields, id: number | undefined): void {
    const auth = fields(data.auth);
    let token = typeof auth.token === 'string' ? existingToken(auth.token) : null;
    if (!token && typeof auth.pairingCode === 'string') {
      if (pairingLockedOut()) return this.error('busy', 'Too many failed attempts — try again shortly', id);
      token = pairWithPin(auth.pairingCode);
    }
    if (!token) return this.error('unauthorized', 'Invalid pairing code or token', id);
    this.authed = true;
    // Always acked, so the client subscribes only once it is in. Swift decodes Data from base64.
    this.send({ paired: { token } }, id);
  }

  private subscribe(data: Fields): void {
    const asked = Array.isArray(data.topics) ? data.topics : [];
    this.topics = new Set(TOPICS.filter((topic) => asked.includes(topic)));
    const { playback, settings } = this.opts;
    if (this.topics.has('nowPlaying')) this.pushNowPlaying(playback.snapshot());
    if (this.topics.has('queue')) this.pushQueue(playback.queueSnapshot());
    if (this.topics.has('settings')) this.sendSettings(settings.snapshot());
  }

  /** Transport commands get no reply (as from the Mac) — only an error when they fail. */
  private async transport(command: Fields, id: number | undefined): Promise<void> {
    const name = Object.keys(command)[0];
    const arg = fields(name ? command[name] : undefined);
    const playback = this.opts.playback;
    switch (name) {
      case 'playPause':
      case 'toggle':
        return playback.transport({ type: 'toggle' });
      case 'play':
      case 'pause':
      case 'stop':
      case 'next':
      case 'previous':
        return playback.transport({ type: name });
      case 'seek':
        return playback.transport({ type: 'seek', seconds: Math.max(0, Number(arg.seconds) || 0) });
      case 'setVolume': {
        const level = Number(arg.level);
        if (!Number.isFinite(level)) return this.error('badRequest', 'Volume needs a level', id);
        return playback.transport({ type: 'setVolume', level: Math.min(1, Math.max(0, level)) });
      }
      case 'playQueueIndex':
        return playback.playQueueIndex(Number(arg.index));
      case 'setShuffle':
        return playback.transport({ type: 'setShuffle', enabled: arg.on === true });
      case 'setRepeat':
        if (!isRepeatMode(arg.mode)) return this.error('badRequest', 'Unknown repeat mode', id);
        return playback.transport({ type: 'setRepeat', mode: arg.mode });
      default:
        return this.error('unsupported', 'This host does not support that command', id);
    }
  }

  /** Like transport: no reply unless the selection names nothing. */
  private async playSelection(selection: Fields, id: number | undefined): Promise<void> {
    const { playback, catalogue, getConfig } = this.opts;
    if (selection.track && typeof selection.track === 'object') {
      const cataloguePath = String(fields(selection.track).cataloguePath ?? '');
      if (!catalogue.getTrack(cataloguePath)) return this.error('notFound', 'Selection not found', id);
      // The song already loaded pauses or resumes; its queue stays.
      return playback.playTrack(cataloguePath);
    }
    if (typeof selection.queueJump === 'number') return playback.playQueueIndex(selection.queueJump);
    const resolved = resolveSelection(catalogue, getConfig().library.roots, selection);
    if (!resolved) return this.error('notFound', 'Selection not found', id);
    return playback.playTracks(resolved.tracks, 0, resolved.source);
  }

  private async artwork(hash: string, maxPixel: number, id: number | undefined): Promise<void> {
    const file = /^[0-9a-f]{8,64}$/i.test(hash) ? this.opts.catalogue.artworkFile(hash) : null;
    const bytes = file ? await remoteArtwork(file, hash, maxPixel) : null;
    if (!bytes) return this.error('notFound', 'Artwork missing', id);
    // The binary frame must follow its header directly.
    this.send({ artworkHeader: { hash, byteCount: bytes.length } }, id);
    if (this.socket.writable) this.socket.write(frame(1, bytes));
  }

  private trackOptions(cataloguePath: string, id: number | undefined): void {
    const options = this.opts.catalogue.trackOptions(cataloguePath);
    if (!options) return this.error('notFound', 'Track not found', id);
    const playlists = options.playlists.map((p) => ({ ...p, id: wirePlaylistId(p.id) }));
    this.send({ trackOptions: { options: { ...options, playlists } } }, id);
  }

  private editTrack(cataloguePath: string, edit: Fields, id: number | undefined): void {
    const catalogue = this.opts.catalogue;
    if (!catalogue.getTrack(cataloguePath)) return this.error('notFound', 'Track not found', id);
    // The app names a playlist by the UUID it was sent for it.
    for (const key of ['addToPlaylist', 'removeFromPlaylist']) {
      if (!edit[key] || typeof edit[key] !== 'object') continue;
      const playlist = findPlaylist(catalogue, String(fields(edit[key]).id ?? ''));
      if (playlist) edit[key] = { id: playlist.id };
    }
    try {
      catalogue.applyTrackEdit(cataloguePath, edit);
    } catch (err) {
      return this.error('badRequest', message(err), id);
    }
    this.trackOptions(cataloguePath, id);
  }

  private pushNowPlaying(snapshot: NowPlayingSnapshot): void {
    this.generation += 1;
    this.send({ nowPlaying: { snapshot: wireNowPlaying(snapshot, this.generation) } });
  }

  private pushQueue(snapshot: QueueSnapshot): void {
    this.generation += 1;
    this.send({ queue: { snapshot: wireQueue(snapshot, this.generation) } });
  }

  /** A reply always goes out; a push only when this client has not got these settings. */
  private sendSettings(snapshot: SettingsSnapshot, id?: number): void {
    const json = JSON.stringify(snapshot);
    if (id === undefined && json === this.lastSettings) return;
    this.lastSettings = json;
    this.send({ settings: { snapshot } }, id);
  }

  private error(code: string, text: string, id?: number): void {
    this.send({ error: { code, message: text } }, id);
  }

  /** One JSON frame; a reply too large for a frame becomes an error for its request. */
  private send(body: Fields, id?: number): void {
    if (!this.socket.writable) return;
    const envelope: { v: number; id?: number; body: Fields } = { v: PROTOCOL_VERSION, body };
    if (id !== undefined) envelope.id = id;
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (payload.length + 1 > MAX_FRAME) {
      console.warn(`Bonjour remote: ${Object.keys(body)[0]} is too large to send (${payload.length} bytes)`);
      if (id !== undefined) this.error('internalError', 'The answer is too large', id);
      return;
    }
    this.socket.write(frame(0, payload));
  }
}

export async function startBonjourRemote(opts: BonjourRemoteOptions): Promise<void> {
  const serverId = loadPairing().serverId;
  const server = net.createServer((socket) => new RemoteSession(socket, opts, serverId).start());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    opts.mdns.publish({
      name: opts.name,
      type: SERVICE_TYPE,
      port: opts.port,
      txt: {
        v: String(PROTOCOL_VERSION),
        id: serverId,
        name: opts.name,
        caps: CAPABILITIES.join(','),
      },
    });
  } catch (err) {
    console.warn('Bonjour publish failed:', err);
  }
}
