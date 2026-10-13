import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { loadConfig, normalizeNetworkDsd, normalizeNetworkStream, saveConfig } from '../config.js';
import {
  DRIVE_BASE,
  DriveError,
  ejectDrive,
  folderStarts,
  listDrives,
  listFolder,
  removeDrive,
  setUpDrive,
} from '../drives.js';
import { engineVersion, listLocalDevices } from '../engine/bridge.js';
import { Catalogue } from '../library/catalogue.js';
import { isAuthorized, isFirstRun, loadPairing, pairingLockedOut, pairWithPin, rotatePin } from '../pairing.js';
import { isRepeatMode, PlaybackService } from '../playback/service.js';
import { dataDir, webDistPath } from '../paths.js';
import type { RemoteSettings } from '../remote/settings.js';
import { systemStatus } from '../system.js';
import type { BrowseScope, HarborConfig, OutputMode, QueueSource, Track } from '../types.js';
import type { Sharing } from '../upnp/sharing.js';

export interface AppContext {
  catalogue: Catalogue;
  playback: PlaybackService;
  getConfig: () => HarborConfig;
  /** The Settings snapshot the remotes show, and changes to it. */
  settings: RemoteSettings;
  sharing: Sharing;
  /** The URL the remotes should open (mDNS name or LAN IP); null until known. */
  remoteUrl?: () => string | null;
}

function authOk(header: string | undefined): boolean {
  if (!header) return false;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return isAuthorized(token);
}

export async function buildServer(ctx: AppContext) {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const webRoot = webDistPath();
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: false,
    });
  }

  // Polled every few seconds by the macOS menu bar app — keep it out of the request log.
  app.get('/api/v1/health', { logLevel: 'warn' }, async () => ({
    ok: true,
    name: ctx.getConfig().server.name,
    engine: engineVersion(),
    url: ctx.remoteUrl?.() ?? null,
  }));

  app.post<{ Body: { pin: string } }>('/api/v1/pair', async (req, reply) => {
    if (pairingLockedOut()) return reply.code(429).send({ error: 'Too many failed attempts — try again shortly' });
    const token = pairWithPin(String(req.body?.pin ?? ''));
    if (!token) return reply.code(401).send({ error: 'invalid pin' });
    return { token };
  });

  // First setup: until a device pairs, the pairing screen shows the PIN — nobody can
  // read it from a headless host otherwise. Afterwards a paired remote shows it.
  app.get('/api/v1/pair/setup', async () =>
    isFirstRun() ? { firstRun: true, pin: loadPairing().pin } : { firstRun: false }
  );

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    const pathOnly = req.url.split('?')[0] ?? req.url;
    if (pathOnly === '/api/v1/health' || pathOnly.startsWith('/api/v1/pair')) return;
    const headerToken = req.headers.authorization;
    // Query parsers turn unescaped + into space; restore for base64 tokens.
    let queryToken = '';
    if (typeof req.query === 'object' && req.query && 'token' in req.query) {
      queryToken = String((req.query as { token?: string }).token ?? '').replace(/ /g, '+');
    }
    if (authOk(headerToken) || isAuthorized(queryToken || null)) return;
    return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/api/v1/now-playing', async () => ctx.playback.snapshot());
  app.get('/api/v1/queue', async () => ctx.playback.queueSnapshot());

  app.get('/api/v1/mounts', async () => {
    const cfg = ctx.getConfig();
    return cfg.library.roots.map((p) => ({
      id: Buffer.from(p).toString('base64url'),
      path: p,
      displayName: path.basename(p),
    }));
  });

  app.post<{ Body: { path: string } }>('/api/v1/mounts', async (req, reply) => {
    const p = path.resolve(String(req.body?.path ?? ''));
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      return reply.code(400).send({ error: 'invalid directory' });
    }
    const cfg = ctx.getConfig();
    if (!cfg.library.roots.includes(p)) cfg.library.roots.push(p);
    saveConfig(cfg);
    ctx.settings.changed();
    // No scan here — the library reads the new folder on Rescan.
    return { roots: cfg.library.roots };
  });

  // Folder picker: the folders inside `path`, or the places to start from without it.
  app.get<{ Querystring: { path?: string } }>('/api/v1/folders', async (req, reply) => {
    if (!req.query.path) return { path: null, parent: null, folders: folderStarts(os.homedir()) };
    try {
      return listFolder(req.query.path);
    } catch {
      return reply.code(400).send({ error: 'Folder not readable' });
    }
  });

  // USB / SATA drives: set up in /etc/fstab under /mnt/harbor through the root helper.
  app.get('/api/v1/drives', async () => listDrives());

  const driveCall = async (reply: FastifyReply, op: () => Promise<unknown>) => {
    try {
      return await op();
    } catch (err) {
      if (err instanceof DriveError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  };

  app.post<{ Body: { uuid?: string; name?: string } }>('/api/v1/drives', async (req, reply) =>
    driveCall(reply, async () => ({
      mountPoint: await setUpDrive(String(req.body?.uuid ?? ''), String(req.body?.name ?? '')),
    }))
  );

  app.post<{ Body: { name?: string } }>('/api/v1/drives/eject', async (req, reply) =>
    driveCall(reply, async () => {
      await ejectDrive(String(req.body?.name ?? ''));
      return { ok: true };
    })
  );

  // Removes the fstab entry and the library folders on the drive.
  app.delete<{ Body: { name?: string } }>('/api/v1/drives', async (req, reply) =>
    driveCall(reply, async () => {
      const name = String(req.body?.name ?? '');
      await removeDrive(name);
      const cfg = ctx.getConfig();
      const mountPoint = `${DRIVE_BASE}/${name}`;
      cfg.library.roots = cfg.library.roots.filter((r) => r !== mountPoint && !r.startsWith(`${mountPoint}/`));
      saveConfig(cfg);
      ctx.settings.changed();
      return { roots: cfg.library.roots };
    })
  );

  app.delete<{ Body: { path: string } }>('/api/v1/mounts', async (req) => {
    const p = String(req.body?.path ?? '');
    const cfg = ctx.getConfig();
    cfg.library.roots = cfg.library.roots.filter((r) => r !== p);
    saveConfig(cfg);
    ctx.settings.changed();
    return { roots: cfg.library.roots };
  });

  // Starts a scan (or joins the running one) and answers at once; progress comes over the
  // WebSocket as `scan` and from GET /api/v1/library/scan.
  // The PIN for pairing another device, on a paired one (Settings → About). Not under
  // /api/v1/pair — that prefix needs no token.
  app.get('/api/v1/remotes/pin', async () => ({ pin: loadPairing().pin }));
  app.post('/api/v1/remotes/pin', async () => ({ pin: rotatePin().pin }));

  app.post('/api/v1/library/rescan', async (req) => {
    const cfg = ctx.getConfig();
    void ctx.catalogue.scanRoots(cfg.library.roots).catch((err) => req.log.warn(err, 'Scan failed'));
    return ctx.catalogue.progress;
  });

  app.get('/api/v1/library/scan', async () => ctx.catalogue.progress);

  // CPU, memory and disk space of the host, for Settings → About.
  app.get('/api/v1/system', async () => systemStatus(dataDir(), ctx.getConfig().library.roots));

  app.get<{
    Querystring: { scope?: BrowseScope; path?: string; q?: string; limit?: string };
  }>('/api/v1/browse', async (req) => {
    const scope = (req.query.scope ?? 'albums') as BrowseScope;
    const cfg = ctx.getConfig();
    if (req.query.q) {
      return { items: ctx.catalogue.search(req.query.q, Number(req.query.limit ?? 50)) };
    }
    return { items: ctx.catalogue.browse(scope, cfg.library.roots, req.query.path) };
  });

  app.get<{ Querystring: { q: string; limit?: string } }>('/api/v1/search', async (req) => {
    return { items: ctx.catalogue.search(req.query.q ?? '', Number(req.query.limit ?? 50)) };
  });

  // The same snapshot the iOS app gets (Swift SettingsSnapshot).
  app.get('/api/v1/settings', async () => ctx.settings.snapshot());

  // One Swift SettingsPatch, e.g. { "dsdPCMLevel": { "value": 6 } } or { "rebuildIndex": true }.
  app.put<{ Body: unknown }>('/api/v1/settings', async (req, reply) => {
    const failure = await ctx.settings.apply(req.body);
    if (failure) return reply.code(400).send({ error: failure });
    return ctx.settings.snapshot();
  });

  app.get('/api/v1/output', async () => ctx.playback.outputStatus());

  // Search for network players now (the output picker opened); they show up within seconds.
  app.post('/api/v1/output/discover', async () => {
    ctx.playback.discoverNetworkPlayers();
    return ctx.playback.outputStatus();
  });

  // What a network player lists (DSD types), its volume and its DSD mode.
  app.get<{ Querystring: { uid?: string } }>('/api/v1/output/formats', async (req, reply) => {
    const uid = req.query.uid ?? '';
    if (!uid.startsWith('upnp:')) return reply.code(400).send({ error: 'uid of a network player required' });
    return ctx.playback.networkFormats(uid);
  });

  app.put<{
    Body: {
      deviceUid?: string | null;
      mode?: OutputMode;
      backend?: 'auto' | 'native' | 'juce';
      networkStream?: string;
      networkDsd?: string;
      dsdPcmLevel?: number;
    };
  }>('/api/v1/output', async (req, reply) => {
    const body = req.body ?? {};
    const cfg = ctx.getConfig();
    if (body.dsdPcmLevel !== undefined) {
      const level = body.dsdPcmLevel;
      if (level !== 0 && level !== 3 && level !== 6) return reply.code(400).send({ error: 'dsdPcmLevel must be 0, 3 or 6' });
      ctx.playback.setDsdPcmLevel(level);
    }
    const backend =
      body.backend === 'juce' ? 'native' : body.backend === undefined ? cfg.output.backend : body.backend;
    await ctx.playback.setOutput(
      body.deviceUid === undefined ? (cfg.output.device_uid ?? null) : body.deviceUid,
      body.mode ?? cfg.output.mode,
      backend,
      body.networkStream === undefined ? undefined : normalizeNetworkStream(body.networkStream),
      body.networkDsd === undefined ? undefined : normalizeNetworkDsd(body.networkDsd)
    );
    return ctx.playback.outputStatus();
  });

  app.post<{
    Body: {
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
      playlistId?: string;
      label?: string;
    };
  }>('/api/v1/play', async (req, reply) => {
    const body = req.body ?? {};
    const roots = ctx.getConfig().library.roots;

    // A tap on the song already loaded pauses or resumes it; the queue stays.
    if (body.cataloguePath && ctx.playback.isCurrentTrack(body.cataloguePath)) {
      await ctx.playback.transport({ type: 'toggle' });
      return ctx.playback.snapshot();
    }

    // Context queues (album / artist / folder / playlist / label), optionally
    // starting at cataloguePath so next/prev walk the same list the user browsed.
    let tracks: Track[] | null = null;
    let source: QueueSource | undefined;
    if (body.albumId) {
      tracks = ctx.catalogue.albumTracks(body.albumId);
      source = { kind: 'Album', name: tracks[0]?.album ?? null };
    } else if (body.artist) {
      tracks = ctx.catalogue.artistTracks(body.artist);
      source = { kind: 'Artist', name: body.artist };
    } else if (body.folder) {
      const paths = ctx.catalogue.resolveSelectionPaths(roots, { folder: body.folder });
      tracks = paths
        .map((p) => ctx.catalogue.getTrack(p))
        .filter((t): t is NonNullable<typeof t> => Boolean(t));
      source = { kind: 'Folder', name: path.basename(body.folder) };
    } else if (body.playlistId) {
      tracks = ctx.catalogue.playlistTracks(body.playlistId);
      if (!tracks.length) return reply.code(404).send({ error: 'playlist empty or missing' });
      source = { kind: 'Playlist', name: ctx.catalogue.getPlaylist(body.playlistId)?.name ?? null };
    } else if (body.label) {
      tracks = ctx.catalogue.tracksForLabel(body.label);
      if (!tracks.length) return reply.code(404).send({ error: 'label empty or missing' });
      source = { kind: 'Label', name: body.label };
    }

    if (tracks) {
      let startIndex = 0;
      if (body.cataloguePath) {
        const idx = tracks.findIndex((t) => t.cataloguePath === body.cataloguePath);
        if (idx >= 0) startIndex = idx;
        else {
          // Path not in context (e.g. stale UI) — fall back to album/single play.
          await ctx.playback.playTrack(body.cataloguePath);
          return ctx.playback.snapshot();
        }
      }
      if (!tracks.length) return reply.code(404).send({ error: 'nothing to play' });
      await ctx.playback.playTracks(tracks, startIndex, source);
      return ctx.playback.snapshot();
    }

    if (body.cataloguePath) {
      await ctx.playback.playTrack(body.cataloguePath);
      return ctx.playback.snapshot();
    }
    return reply.code(400).send({ error: 'nothing to play' });
  });

  app.get('/api/v1/playlists', async () => ({
    playlists: ctx.catalogue.listPlaylists().map((p) => ({
      id: p.id,
      name: p.name,
      trackCount: p.paths.length,
    })),
  }));

  app.post<{ Body: { name?: string } }>('/api/v1/playlists', async (req, reply) => {
    try {
      const pl = ctx.catalogue.createPlaylist(String(req.body?.name ?? ''));
      return { id: pl.id, name: pl.name, trackCount: pl.paths.length };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/v1/playlists/:id',
    async (req, reply) => {
      try {
        ctx.catalogue.renamePlaylist(req.params.id, String(req.body?.name ?? ''));
        return ctx.catalogue.getPlaylist(req.params.id);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
      }
    }
  );

  app.delete<{ Params: { id: string } }>('/api/v1/playlists/:id', async (req, reply) => {
    try {
      ctx.catalogue.deletePlaylist(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/playlists/:id/tracks', async (req, reply) => {
    const pl = ctx.catalogue.getPlaylist(req.params.id);
    if (!pl) return reply.code(404).send({ error: 'playlist not found' });
    return { id: pl.id, name: pl.name, tracks: ctx.catalogue.playlistTracks(pl.id) };
  });

  app.post<{
    Params: { id: string };
    Body: {
      paths?: string[];
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    };
  }>('/api/v1/playlists/:id/items', async (req, reply) => {
    try {
      const paths = ctx.catalogue.resolveSelectionPaths(
        ctx.getConfig().library.roots,
        req.body ?? {}
      );
      if (!paths.length) return reply.code(400).send({ error: 'nothing to add' });
      const added = ctx.catalogue.addPathsToPlaylist(req.params.id, paths);
      const pl = ctx.catalogue.getPlaylist(req.params.id);
      return { added, trackCount: pl?.paths.length ?? 0 };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  app.delete<{ Params: { id: string }; Body: { paths?: string[]; cataloguePath?: string } }>(
    '/api/v1/playlists/:id/items',
    async (req, reply) => {
      try {
        const paths = [
          ...(req.body?.paths ?? []),
          ...(req.body?.cataloguePath ? [req.body.cataloguePath] : []),
        ];
        ctx.catalogue.removePathsFromPlaylist(req.params.id, paths);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
      }
    }
  );

  app.get('/api/v1/labels', async () => ({
    labels: ctx.catalogue.allLabels().map((name) => ({
      name,
      trackCount: ctx.catalogue.tracksForLabel(name).length,
    })),
  }));

  app.get<{ Params: { name: string } }>('/api/v1/labels/:name/tracks', async (req) => {
    const name = decodeURIComponent(req.params.name);
    return { name, tracks: ctx.catalogue.tracksForLabel(name) };
  });

  app.post<{
    Body: {
      name?: string;
      paths?: string[];
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    };
  }>('/api/v1/labels/items', async (req, reply) => {
    try {
      const name = String(req.body?.name ?? '').trim();
      const paths = ctx.catalogue.resolveSelectionPaths(
        ctx.getConfig().library.roots,
        req.body ?? {}
      );
      if (!name) return reply.code(400).send({ error: 'label name required' });
      if (!paths.length) {
        return reply.code(400).send({ error: 'nothing to label — pick a song, album, or artist' });
      }
      const added = ctx.catalogue.addLabelToPaths(name, paths);
      if (!added) {
        return reply.code(400).send({ error: 'could not apply label to any tracks' });
      }
      return { added, name };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  const removeLabelItems = async (
    body: {
      name?: string;
      paths?: string[];
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    try {
      const name = String(body?.name ?? '').trim();
      const paths = ctx.catalogue.resolveSelectionPaths(ctx.getConfig().library.roots, body ?? {});
      if (!name || !paths.length) {
        return reply.code(400).send({ error: 'name and selection required' });
      }
      ctx.catalogue.removeLabelFromPaths(name, paths);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  };

  // POST preferred — some stacks drop DELETE bodies.
  app.post<{
    Body: {
      name?: string;
      paths?: string[];
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    };
  }>('/api/v1/labels/remove-items', async (req, reply) => removeLabelItems(req.body ?? {}, reply));

  app.delete<{
    Body: {
      name?: string;
      paths?: string[];
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    };
  }>('/api/v1/labels/items', async (req, reply) => removeLabelItems(req.body ?? {}, reply));

  app.patch<{ Params: { name: string }; Body: { name?: string } }>(
    '/api/v1/labels/:name',
    async (req, reply) => {
      try {
        const from = decodeURIComponent(req.params.name);
        const to = String(req.body?.name ?? '').trim();
        if (!to) return reply.code(400).send({ error: 'name required' });
        const n = ctx.catalogue.renameLabel(from, to);
        if (!n && !ctx.catalogue.allLabels().includes(to)) {
          return reply.code(404).send({ error: 'label not found' });
        }
        return { name: to };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
      }
    }
  );

  app.delete<{ Params: { name: string } }>('/api/v1/labels/:name', async (req, reply) => {
    const name = decodeURIComponent(req.params.name);
    const removed = ctx.catalogue.deleteLabel(name);
    if (!removed) return reply.code(404).send({ error: 'label not found' });
    return { ok: true, removed };
  });

  app.get<{ Querystring: { path?: string } }>('/api/v1/track-options', async (req, reply) => {
    const cataloguePath = String(req.query.path ?? '');
    const options = ctx.catalogue.trackOptions(cataloguePath);
    if (!options) return reply.code(404).send({ error: 'track not found' });
    return options;
  });

  app.post<{ Body: { cataloguePath?: string; edit?: Record<string, unknown> } }>(
    '/api/v1/track-edit',
    async (req, reply) => {
      try {
        const cataloguePath = String(req.body?.cataloguePath ?? '');
        ctx.catalogue.applyTrackEdit(cataloguePath, req.body?.edit ?? {});
        return ctx.catalogue.trackOptions(cataloguePath);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
      }
    }
  );

  app.post<{
    Body: {
      command: string;
      seconds?: number;
      level?: number;
      enabled?: boolean;
      mode?: string;
      index?: number;
    };
  }>('/api/v1/transport', async (req, reply) => {
    const c = req.body?.command;
    switch (c) {
      case 'play':
      case 'pause':
      case 'toggle':
      case 'stop':
      case 'next':
      case 'previous':
        await ctx.playback.transport({ type: c });
        break;
      case 'seek':
        await ctx.playback.transport({ type: 'seek', seconds: Number(req.body?.seconds ?? 0) });
        break;
      case 'setVolume':
        await ctx.playback.transport({ type: 'setVolume', level: Number(req.body?.level ?? 0) });
        break;
      case 'setShuffle':
        await ctx.playback.transport({
          type: 'setShuffle',
          enabled: Boolean(req.body?.enabled),
        });
        break;
      case 'setRepeat':
        await ctx.playback.transport({
          type: 'setRepeat',
          mode: isRepeatMode(req.body?.mode) ? req.body.mode : 'off',
        });
        break;
      // Jumps within the queue as it plays (shuffled or not); the current track toggles.
      case 'playQueueIndex':
        await ctx.playback.playQueueIndex(Number(req.body?.index));
        break;
      default:
        return reply.code(400).send({ error: 'unknown command' });
    }
    return ctx.playback.snapshot();
  });

  app.get<{ Params: { hash: string } }>('/api/v1/artwork/:hash', async (req, reply) => {
    const file = ctx.catalogue.artworkFile(req.params.hash);
    if (!file) return reply.code(404).send({ error: 'not found' });
    const buf = fs.readFileSync(file);
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    reply.header('Cache-Control', 'private, max-age=604800, immutable');
    return reply.type(isPng ? 'image/png' : 'image/jpeg').send(buf);
  });

  app.get('/api/v1/devices', async () => ({ devices: listLocalDevices() }));

  const sharingStatus = () => ({
    ...ctx.getConfig().sharing,
    statusText: ctx.sharing.statusText,
    activeStreams: ctx.sharing.activeStreams,
  });

  app.get('/api/v1/sharing', async () => sharingStatus());

  // Takes effect at once: the DLNA server starts, stops, or starts again on the new port / name.
  app.put<{ Body: { enabled?: boolean; port?: number; friendly_name?: string } }>(
    '/api/v1/sharing',
    async (req) => {
      const cfg = ctx.getConfig();
      const wasRunning = ctx.sharing.running;
      let moved = false;
      if (req.body?.port !== undefined && Number(req.body.port) !== cfg.sharing.port) {
        cfg.sharing.port = Number(req.body.port);
        moved = true;
      }
      if (req.body?.friendly_name !== undefined && String(req.body.friendly_name) !== cfg.sharing.friendly_name) {
        cfg.sharing.friendly_name = String(req.body.friendly_name);
        moved = true;
      }
      saveConfig(cfg);
      if (req.body?.enabled !== undefined) await ctx.sharing.setEnabled(Boolean(req.body.enabled));
      if (moved && wasRunning && ctx.sharing.running) await ctx.sharing.restart();
      return sharingStatus();
    }
  );

  app.register(async (wsApp) => {
    wsApp.get('/api/v1/ws', { websocket: true }, (socket, req) => {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (!isAuthorized(token)) {
        socket.close(4401, 'unauthorized');
        return;
      }
      const send = (type: string, payload: unknown) => {
        socket.send(JSON.stringify({ type, payload }));
      };
      send('nowPlaying', ctx.playback.snapshot());
      send('queue', ctx.playback.queueSnapshot());
      send('settings', ctx.settings.snapshot());
      send('scan', ctx.catalogue.progress);
      const onNp = (p: unknown) => send('nowPlaying', p);
      const onQ = (p: unknown) => send('queue', p);
      const onScan = (p: unknown) => send('scan', p);
      ctx.playback.on('nowPlaying', onNp);
      ctx.playback.on('queue', onQ);
      ctx.catalogue.on('progress', onScan);
      const unwatch = ctx.settings.watch((p) => send('settings', p));
      socket.on('close', () => {
        ctx.playback.off('nowPlaying', onNp);
        ctx.playback.off('queue', onQ);
        ctx.catalogue.off('progress', onScan);
        unwatch();
      });
    });
  });

  // SPA fallback
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    const index = path.join(webRoot, 'index.html');
    if (fs.existsSync(index)) {
      return reply.type('text/html').send(fs.readFileSync(index));
    }
    return reply.code(404).send('Web UI not built. Run npm run build:web');
  });

  return app;
}

export function printPairingInfo(): void {
  const pairing = loadPairing();
  console.log(`Pairing PIN: ${pairing.pin}`);
}

export { rotatePin, loadPairing };
