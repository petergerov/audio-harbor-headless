import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { httpRequest } from './httpClient.js';
import { parseDeviceDescription, serviceShortName } from './xml.js';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const USER_AGENT = `${os.type()}/${os.release()} UPnP/1.1 AudioHarborHeadless/1.0`;
const SEARCH_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 15_000;
const DEFAULT_MAX_AGE_S = 1800;
/** A device without AVTransport is not asked again for this long. */
const NOT_A_RENDERER_MS = 10 * 60_000;

export interface RendererService {
  url: string;
  type: string;
}

/** A UPnP MediaRenderer on the LAN — enough for the output picker and to drive it. */
export interface UpnpRenderer {
  udn: string;
  name: string;
  manufacturer: string;
  modelName: string;
  location: string;
  /** Peer IPv4 from the SSDP packet — media URLs use this host's address toward it. */
  host: string;
  avTransport: RendererService;
  renderingControl: RendererService;
  connectionManager: RendererService | null;
  expiresAt: number;
}

/** Stable pick key stored as `output.device_uid`. */
export function rendererUid(udn: string): string {
  return `upnp:${udn}`;
}

export function isNetworkUid(uid: string | null | undefined): uid is string {
  return Boolean(uid?.startsWith('upnp:'));
}

/** `uuid:…` from a USN such as `uuid:…::urn:schemas-upnp-org:device:MediaRenderer:1`. */
export function ssdpUdn(usn: string): string {
  const colon = usn.indexOf(':');
  if (colon < 0 || usn.slice(0, colon).toLowerCase() !== 'uuid') return usn;
  const rest = usn.slice(colon + 1);
  const cut = rest.indexOf('::');
  return `uuid:${cut >= 0 ? rest.slice(0, cut) : rest}`;
}

/** Whether a renderer is the one a stored pick names (case and USN suffixes ignored). */
export function rendererMatches(renderer: UpnpRenderer, uid: string): boolean {
  return sameRendererUid(renderer.udn, uid);
}

/** Whether two picks (`upnp:<UDN>` or a bare UDN / USN) name the same renderer. */
export function sameRendererUid(a: string, b: string): boolean {
  const key = (uid: string) => ssdpUdn(uid.startsWith('upnp:') ? uid.slice('upnp:'.length) : uid).toLowerCase();
  return key(a) === key(b);
}

function headers(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of message.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out.set(line.slice(0, colon).trim().toUpperCase(), line.slice(colon + 1).trim());
  }
  return out;
}

function maxAgeSeconds(h: Map<string, string>): number | null {
  const cache = h.get('CACHE-CONTROL')?.toLowerCase() ?? '';
  const m = /max-age\s*=\s*(\d+)/.exec(cache);
  return m ? Math.max(60, Number(m[1])) : null;
}

/** IPv4 addresses to search from — the LAN interfaces, or loopback when there is none. */
function searchAddresses(): string[] {
  const lan: string[] = [];
  const loopback: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family !== 'IPv4') continue;
      (e.internal ? loopback : lan).push(e.address);
    }
  }
  return lan.length ? lan : loopback.slice(0, 1);
}

interface SearchHit {
  location: string;
  host: string;
  maxAge: number;
  usn: string;
}

/**
 * Discovers UPnP MediaRenderers (M-SEARCH every 30 s, NOTIFY alive / byebye, max-age expiry)
 * and keeps a live list for the output picker. Emits `change` with the list.
 */
export class RendererBrowser extends EventEmitter {
  renderers: UpnpRenderer[] = [];
  /** Set when searching fails, e.g. no network or no Local Network access. */
  lastError: string | null = null;

  private running = false;
  private searchTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private notifySocket: dgram.Socket | null = null;
  private inFlight = new Set<string>();
  private notRenderers = new Map<string, number>();

  start(): void {
    if (this.running) return;
    this.running = true;
    this.listenForNotify();
    void this.searchOnce();
    this.searchTimer = setInterval(() => void this.searchOnce(), SEARCH_INTERVAL_MS);
    this.pruneTimer = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
    this.searchTimer.unref();
    this.pruneTimer.unref();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.searchTimer) clearInterval(this.searchTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.searchTimer = null;
    this.pruneTimer = null;
    try {
      this.notifySocket?.close();
    } catch {
      /* already closed */
    }
    this.notifySocket = null;
    this.renderers = [];
    this.emit('change', this.renderers);
  }

  /** One M-SEARCH round now — after a pick was not found, or when the picker opens. */
  searchNow(): void {
    if (this.running) void this.searchOnce();
  }

  find(uid: string): UpnpRenderer | null {
    return this.renderers.find((r) => rendererMatches(r, uid)) ?? null;
  }

  // M-SEARCH from every LAN interface, so a multi-homed host finds players on each network.

  private async searchOnce(): Promise<void> {
    const addresses = searchAddresses();
    const results = await Promise.all(addresses.map((address) => this.searchFrom(address)));
    const errors = results.map((r) => r.error).filter((e): e is string => Boolean(e));
    this.lastError = addresses.length === 0 ? 'No network' : errors.length === results.length ? errors[0]! : null;
    const seen = new Set<string>();
    for (const hit of results.flatMap((r) => r.hits)) {
      if (seen.has(hit.location)) continue;
      seen.add(hit.location);
      void this.considerLocation(hit);
    }
  }

  private searchFrom(address: string): Promise<{ hits: SearchHit[]; error: string | null }> {
    return new Promise((resolve) => {
      const hits: SearchHit[] = [];
      let error: string | null = null;
      const socket = dgram.createSocket({ type: 'udp4' });
      const message = Buffer.from(
        [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 2',
          `ST: ${SEARCH_TARGET}`,
          `USER-AGENT: ${USER_AGENT}`,
          '',
          '',
        ].join('\r\n')
      );
      const send = () => {
        socket.send(message, SSDP_PORT, SSDP_ADDRESS, (err) => {
          if (err) error = err.message;
        });
      };
      const finish = () => {
        try {
          socket.close();
        } catch {
          /* closed */
        }
        resolve({ hits, error });
      };
      socket.on('error', (err) => {
        error = err.message;
        finish();
      });
      socket.on('message', (buf, rinfo) => {
        const text = buf.toString('utf8');
        if (!/^HTTP\/1\.[01] 200/i.test(text)) return;
        const h = headers(text);
        const location = h.get('LOCATION');
        if (!location) return;
        hits.push({
          location,
          host: rinfo.address,
          maxAge: maxAgeSeconds(h) ?? DEFAULT_MAX_AGE_S,
          usn: h.get('USN') ?? '',
        });
      });
      socket.bind(0, address, () => {
        try {
          socket.setMulticastTTL(4);
          socket.setMulticastInterface(address);
        } catch {
          /* default interface */
        }
        send();
        setTimeout(send, 1500).unref();
        setTimeout(finish, 3000).unref();
      });
    });
  }

  // NOTIFY on 1900 — shared with the DLNA server's responder (SO_REUSEADDR / SO_REUSEPORT).

  private listenForNotify(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
      console.warn(`SSDP notify listener: ${err.message}`);
      try {
        socket.close();
      } catch {
        /* closed */
      }
      if (this.notifySocket === socket) this.notifySocket = null;
    });
    socket.on('message', (buf, rinfo) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('NOTIFY')) return;
      this.handleNotify(headers(text), rinfo.address);
    });
    socket.bind(SSDP_PORT, () => {
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const e of entries ?? []) {
          if (e.family !== 'IPv4') continue;
          try {
            socket.addMembership(SSDP_ADDRESS, e.address);
          } catch {
            /* interface without multicast */
          }
        }
      }
    });
    this.notifySocket = socket;
  }

  private handleNotify(h: Map<string, string>, host: string): void {
    const nts = h.get('NTS')?.toLowerCase() ?? '';
    const usn = h.get('USN') ?? '';
    if (nts.includes('byebye')) {
      this.removeRenderer(ssdpUdn(usn));
      return;
    }
    if (!nts.includes('alive') && !nts.includes('update')) return;
    const nt = h.get('NT') ?? '';
    const relevant =
      nt.includes('MediaRenderer') || usn.includes('MediaRenderer') || nt === 'upnp:rootdevice';
    const location = h.get('LOCATION');
    if (!relevant || !location) return;
    void this.considerLocation({ location, host, maxAge: maxAgeSeconds(h) ?? DEFAULT_MAX_AGE_S, usn });
  }

  // Description

  private async considerLocation(hit: SearchHit): Promise<void> {
    const now = Date.now();
    const udn = hit.usn ? ssdpUdn(hit.usn) : null;
    const known =
      this.renderers.find((r) => r.location === hit.location) ??
      (udn ? this.renderers.find((r) => ssdpUdn(r.udn) === udn) : undefined);
    if (known && known.location === hit.location) {
      known.expiresAt = Math.max(known.expiresAt, now + hit.maxAge * 1000);
      return;
    }
    // A known renderer at a new address (restarted on another port) is described again.
    const skipUntil = this.notRenderers.get(hit.location);
    if (!known && skipUntil && skipUntil > now) return;
    if (this.inFlight.has(hit.location)) return;
    this.inFlight.add(hit.location);
    try {
      const res = await httpRequest(hit.location, {
        headers: { 'User-Agent': USER_AGENT },
        timeoutMs: 8000,
      });
      if (res.status !== 200) return;
      const renderer = this.rendererFrom(res.body, hit);
      if (!renderer) {
        this.notRenderers.set(hit.location, now + NOT_A_RENDERER_MS);
        return;
      }
      this.upsert(renderer);
    } catch {
      // Unreachable for now; the next search or NOTIFY tries again.
    } finally {
      this.inFlight.delete(hit.location);
    }
  }

  private rendererFrom(xml: string, hit: SearchHit): UpnpRenderer | null {
    const d = parseDeviceDescription(xml);
    const service = (name: string): RendererService | null => {
      const s = d.services.find((x) => serviceShortName(x.serviceType) === name);
      if (!s?.controlURL) return null;
      try {
        return { url: new URL(s.controlURL, d.urlBase ?? hit.location).toString(), type: s.serviceType };
      } catch {
        return null;
      }
    };
    const avTransport = service('AVTransport');
    const renderingControl = service('RenderingControl');
    const name = d.friendlyName || d.modelName;
    if (!avTransport || !renderingControl || !d.udn || !name) return null;
    return {
      udn: d.udn,
      name,
      manufacturer: d.manufacturer,
      modelName: d.modelName,
      location: hit.location,
      host: hit.host,
      avTransport: {
        url: avTransport.url,
        type: avTransport.type || 'urn:schemas-upnp-org:service:AVTransport:1',
      },
      renderingControl: {
        url: renderingControl.url,
        type: renderingControl.type || 'urn:schemas-upnp-org:service:RenderingControl:1',
      },
      connectionManager: service('ConnectionManager'),
      expiresAt: Date.now() + hit.maxAge * 1000,
    };
  }

  private upsert(renderer: UpnpRenderer): void {
    const index = this.renderers.findIndex((r) => ssdpUdn(r.udn) === ssdpUdn(renderer.udn));
    if (index >= 0) {
      this.renderers[index] = renderer;
    } else {
      this.renderers.push(renderer);
      this.renderers.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      console.log(`Network player found: ${renderer.name} (${renderer.udn})`);
    }
    this.renderers = [...this.renderers];
    this.emit('change', this.renderers);
  }

  private removeRenderer(udn: string): void {
    const before = this.renderers.length;
    this.renderers = this.renderers.filter((r) => ssdpUdn(r.udn).toLowerCase() !== udn.toLowerCase());
    if (this.renderers.length === before) return;
    console.log(`Network player left: ${udn}`);
    this.emit('change', this.renderers);
  }

  private pruneExpired(): void {
    const now = Date.now();
    const before = this.renderers.length;
    this.renderers = this.renderers.filter((r) => r.expiresAt >= now);
    if (this.renderers.length !== before) this.emit('change', this.renderers);
    for (const [location, until] of this.notRenderers) {
      if (until <= now) this.notRenderers.delete(location);
    }
  }
}
