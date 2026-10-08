import http from 'node:http';
import fs from 'node:fs';
import {
  fetchRendererDescription,
  pauseRenderer,
  playRenderer,
  setAvTransportUri,
  setNextAvTransportUri,
} from './rendererControl.js';
import { lanIp } from '../net.js';
import type { OutputDevice } from '../types.js';

export interface DiscoveredRenderer extends OutputDevice {
  location?: string;
  avTransportUrl?: string | null;
  renderingControlUrl?: string | null;
}

let mediaPort = 8201;
let mediaServer: http.Server | null = null;
const tokens = new Map<string, string>(); // token -> file path

export async function enrichRenderers(
  devices: OutputDevice[],
  locations: Map<string, string>
): Promise<DiscoveredRenderer[]> {
  const out: DiscoveredRenderer[] = [];
  for (const d of devices) {
    const location = locations.get(d.uid);
    if (!location) {
      out.push(d);
      continue;
    }
    try {
      const desc = await fetchRendererDescription(location);
      out.push({
        ...d,
        name: desc.friendlyName,
        location,
        avTransportUrl: desc.avTransportUrl,
        renderingControlUrl: desc.renderingControlUrl,
      });
    } catch {
      out.push({ ...d, location });
    }
  }
  return out;
}

export async function ensureMediaHttpServer(port = 8201): Promise<number> {
  if (mediaServer) return mediaPort;
  mediaPort = port;
  mediaServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${mediaPort}`);
    if (!url.pathname.startsWith('/t/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const token = url.pathname.slice(3);
    const filePath = tokens.get(token);
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const st = fs.statSync(filePath);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : st.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
          'Content-Type': 'application/octet-stream',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((resolve) => mediaServer!.listen(mediaPort, '0.0.0.0', resolve));
  return mediaPort;
}

function mediaUriFor(filePath: string): string {
  const token = Math.random().toString(36).slice(2);
  tokens.set(token, filePath);
  return `http://${lanIp()}:${mediaPort}/t/${token}`;
}

export async function playOnRenderer(
  renderer: DiscoveredRenderer,
  filePath: string
): Promise<void> {
  if (!renderer.avTransportUrl) throw new Error('Renderer has no AVTransport');
  await ensureMediaHttpServer();
  const uri = mediaUriFor(filePath);
  await setAvTransportUri(renderer.avTransportUrl, uri);
  await playRenderer(renderer.avTransportUrl);
}

export async function prepareNextOnRenderer(
  renderer: DiscoveredRenderer,
  filePath: string
): Promise<void> {
  if (!renderer.avTransportUrl) return;
  await ensureMediaHttpServer();
  try {
    await setNextAvTransportUri(renderer.avTransportUrl, mediaUriFor(filePath));
  } catch {
    // Many renderers lack SetNext — ignore quietly
  }
}

export async function pauseOnRenderer(renderer: DiscoveredRenderer): Promise<void> {
  if (!renderer.avTransportUrl) return;
  await pauseRenderer(renderer.avTransportUrl);
}
