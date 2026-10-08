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
    if (req.url === '/api/v1/health' || req.url.startsWith('/api/v1/pair')) return;
    const headerToken = req.headers.authorization;
    const queryToken =
      typeof req.query === 'object' && req.query && 'token' in req.query
        ? String((req.query as { token?: string }).token ?? '')
        : '';
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

  app.put<{ Body: { deviceUid?: string | null; mode?: OutputMode } }>(
    '/api/v1/output',
    async (req) => {
      const body = req.body ?? {};
      const cfg = ctx.getConfig();
      ctx.playback.setOutput(
        body.deviceUid === undefined ? (cfg.output.device_uid ?? null) : body.deviceUid,
        body.mode ?? cfg.output.mode
      );
      return ctx.playback.snapshot().output;
    }
  );

  app.post<{
    Body: {
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    };
  }>('/api/v1/play', async (req, reply) => {
    const body = req.body ?? {};
    if (body.cataloguePath) {
      await ctx.playback.playTrack(body.cataloguePath);
      return ctx.playback.snapshot();
    }
    if (body.albumId) {
      const tracks = ctx.catalogue.albumTracks(body.albumId);
      await ctx.playback.playTracks(tracks);
      return ctx.playback.snapshot();
    }
    if (body.artist) {
      const tracks = ctx.catalogue.artistTracks(body.artist);
      await ctx.playback.playTracks(tracks);
      return ctx.playback.snapshot();
    }
    if (body.folder) {
      const entries = ctx.catalogue.browseFolder(ctx.getConfig().library.roots, body.folder);
      const tracks = entries.map((e) => e.track).filter(Boolean);
      await ctx.playback.playTracks(tracks as NonNullable<(typeof tracks)[number]>[]);
      return ctx.playback.snapshot();
    }
    return reply.code(400).send({ error: 'nothing to play' });
  });

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
    return reply.type('image/jpeg').send(fs.readFileSync(file));
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
