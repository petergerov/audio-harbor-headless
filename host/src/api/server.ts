import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { loadConfig, saveConfig } from '../config.js';
import { engineVersion, listLocalDevices } from '../engine/bridge.js';
import { Catalogue } from '../library/catalogue.js';
import { isAuthorized, loadPairing, pairWithPin, rotatePin } from '../pairing.js';
import { PlaybackService } from '../playback/service.js';
import { webDistPath } from '../paths.js';
import type { BrowseScope, HarborConfig, OutputMode } from '../types.js';

export interface AppContext {
  catalogue: Catalogue;
  playback: PlaybackService;
  getConfig: () => HarborConfig;
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

  app.get('/api/v1/health', async () => ({
    ok: true,
    name: ctx.getConfig().server.name,
    engine: engineVersion(),
  }));

  app.post<{ Body: { pin: string } }>('/api/v1/pair', async (req, reply) => {
    const token = pairWithPin(String(req.body?.pin ?? ''));
    if (!token) return reply.code(401).send({ error: 'invalid pin' });
    return { token };
  });

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
    await ctx.catalogue.scanRoots(cfg.library.roots);
    return { roots: cfg.library.roots };
  });

  app.delete<{ Body: { path: string } }>('/api/v1/mounts', async (req) => {
    const p = String(req.body?.path ?? '');
    const cfg = ctx.getConfig();
    cfg.library.roots = cfg.library.roots.filter((r) => r !== p);
    saveConfig(cfg);
    return { roots: cfg.library.roots };
  });

  app.post('/api/v1/library/rescan', async () => {
    const cfg = ctx.getConfig();
    return ctx.catalogue.scanRoots(cfg.library.roots);
  });

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

  app.get('/api/v1/output', async () => ctx.playback.snapshot().output);

  app.put<{
    Body: {
      deviceUid?: string | null;
      mode?: OutputMode;
      backend?: 'auto' | 'juce' | 'native';
    };
  }>('/api/v1/output', async (req) => {
    const body = req.body ?? {};
    const cfg = ctx.getConfig();
    ctx.playback.setOutput(
      body.deviceUid === undefined ? (cfg.output.device_uid ?? null) : body.deviceUid,
      body.mode ?? cfg.output.mode,
      body.backend ?? cfg.output.backend
    );
    return ctx.playback.snapshot().output;
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

    // Context queues (album / artist / folder / playlist / label), optionally
    // starting at cataloguePath so next/prev walk the same list the user browsed.
    let tracks:
      | ReturnType<typeof ctx.catalogue.albumTracks>
      | null = null;
    if (body.albumId) {
      tracks = ctx.catalogue.albumTracks(body.albumId);
    } else if (body.artist) {
      tracks = ctx.catalogue.artistTracks(body.artist);
    } else if (body.folder) {
      const paths = ctx.catalogue.resolveSelectionPaths(roots, { folder: body.folder });
      tracks = paths
        .map((p) => ctx.catalogue.getTrack(p))
        .filter((t): t is NonNullable<typeof t> => Boolean(t));
    } else if (body.playlistId) {
      tracks = ctx.catalogue.playlistTracks(body.playlistId);
      if (!tracks.length) return reply.code(404).send({ error: 'playlist empty or missing' });
    } else if (body.label) {
      tracks = ctx.catalogue.tracksForLabel(body.label);
      if (!tracks.length) return reply.code(404).send({ error: 'label empty or missing' });
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
      await ctx.playback.playTracks(tracks, startIndex);
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
          mode: (req.body?.mode as 'off' | 'all' | 'one') ?? 'off',
        });
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

  app.get('/api/v1/sharing', async () => ctx.getConfig().sharing);

  app.put<{ Body: { enabled?: boolean; port?: number; friendly_name?: string } }>(
    '/api/v1/sharing',
    async (req) => {
      const cfg = ctx.getConfig();
      if (req.body?.enabled !== undefined) cfg.sharing.enabled = Boolean(req.body.enabled);
      if (req.body?.port !== undefined) cfg.sharing.port = Number(req.body.port);
      if (req.body?.friendly_name !== undefined) {
        cfg.sharing.friendly_name = String(req.body.friendly_name);
      }
      saveConfig(cfg);
      return cfg.sharing;
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
      const onNp = (p: unknown) => send('nowPlaying', p);
      const onQ = (p: unknown) => send('queue', p);
      ctx.playback.on('nowPlaying', onNp);
      ctx.playback.on('queue', onQ);
      socket.on('close', () => {
        ctx.playback.off('nowPlaying', onNp);
        ctx.playback.off('queue', onQ);
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
