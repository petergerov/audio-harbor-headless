import { HttpTimeoutError, httpRequest } from './httpClient.js';
import type { RendererService, UpnpRenderer } from './ssdp.js';
import { escapeXml, xmlLeaves } from './xml.js';

/** A SOAP fault (or HTTP error) from the renderer. */
export class UpnpError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly code: string | null,
    detail: string
  ) {
    super(`${action}: ${detail}`);
    this.name = 'UpnpError';
  }
}

export function isTimeout(err: unknown): boolean {
  return err instanceof HttpTimeoutError;
}

export interface TransportInfo {
  state: string;
  status: string;
}

export interface PositionInfo {
  duration: number | null;
  relTime: number | null;
  uri: string;
}

type Service = 'avTransport' | 'renderingControl' | 'connectionManager';

/** SOAP action against a MediaRenderer; resolves the answer's arguments by name. */
async function call(
  renderer: UpnpRenderer,
  service: Service,
  action: string,
  args: Array<[string, string]>,
  timeoutMs = 10_000
): Promise<Map<string, string>> {
  const endpoint: RendererService | null = renderer[service];
  if (!endpoint) throw new UpnpError(action, 0, null, `${renderer.name} has no ${service} service`);
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${endpoint.type}">` +
    args.map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await httpRequest(endpoint.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${endpoint.type}#${action}"`,
    },
    body,
    timeoutMs,
  });
  const values = xmlLeaves(res.body);
  if (res.status !== 200) {
    const code = values.get('errorCode') ?? null;
    const detail =
      values.get('errorDescription') ?? (code ? `UPnP error ${code}` : `HTTP ${res.status}`);
    throw new UpnpError(action, res.status, code, detail);
  }
  return values;
}

// AVTransport — Play and SetAVTransportURI often block while the renderer buffers (Bose, Sonos).

export async function setAVTransportURI(r: UpnpRenderer, uri: string, metadata: string): Promise<void> {
  await call(
    r,
    'avTransport',
    'SetAVTransportURI',
    [
      ['InstanceID', '0'],
      ['CurrentURI', uri],
      ['CurrentURIMetaData', metadata],
    ],
    30_000
  );
}

export async function setNextAVTransportURI(r: UpnpRenderer, uri: string, metadata: string): Promise<void> {
  await call(
    r,
    'avTransport',
    'SetNextAVTransportURI',
    [
      ['InstanceID', '0'],
      ['NextURI', uri],
      ['NextURIMetaData', metadata],
    ],
    15_000
  );
}

export async function play(r: UpnpRenderer): Promise<void> {
  await call(r, 'avTransport', 'Play', [['InstanceID', '0'], ['Speed', '1']], 45_000);
}

export async function pause(r: UpnpRenderer): Promise<void> {
  await call(r, 'avTransport', 'Pause', [['InstanceID', '0']]);
}

export async function stop(r: UpnpRenderer): Promise<void> {
  await call(r, 'avTransport', 'Stop', [['InstanceID', '0']]);
}

export async function seek(r: UpnpRenderer, seconds: number): Promise<void> {
  await call(r, 'avTransport', 'Seek', [
    ['InstanceID', '0'],
    ['Unit', 'REL_TIME'],
    ['Target', formatTime(seconds)],
  ]);
}

export async function getTransportInfo(r: UpnpRenderer): Promise<TransportInfo> {
  const v = await call(r, 'avTransport', 'GetTransportInfo', [['InstanceID', '0']]);
  return {
    state: (v.get('CurrentTransportState') ?? '').toUpperCase(),
    status: (v.get('CurrentTransportStatus') ?? '').toUpperCase(),
  };
}

export async function getPositionInfo(r: UpnpRenderer): Promise<PositionInfo> {
  const v = await call(r, 'avTransport', 'GetPositionInfo', [['InstanceID', '0']]);
  return {
    duration: parseTime(v.get('TrackDuration')),
    relTime: parseTime(v.get('RelTime')),
    uri: v.get('TrackURI') ?? '',
  };
}

// RenderingControl

export async function getVolume(r: UpnpRenderer): Promise<number> {
  const v = await call(r, 'renderingControl', 'GetVolume', [
    ['InstanceID', '0'],
    ['Channel', 'Master'],
  ]);
  const level = Number(v.get('CurrentVolume'));
  if (!Number.isFinite(level)) throw new UpnpError('GetVolume', 200, null, 'no CurrentVolume');
  return level;
}

export async function setVolume(r: UpnpRenderer, level0to100: number): Promise<void> {
  await call(r, 'renderingControl', 'SetVolume', [
    ['InstanceID', '0'],
    ['Channel', 'Master'],
    ['DesiredVolume', String(Math.round(Math.min(100, Math.max(0, level0to100))))],
  ]);
}

// ConnectionManager

export async function getProtocolInfo(r: UpnpRenderer): Promise<{ source: string; sink: string }> {
  const v = await call(r, 'connectionManager', 'GetProtocolInfo', []);
  return { source: v.get('Source') ?? '', sink: v.get('Sink') ?? '' };
}

// Time

/** `H:MM:SS` for Seek and DIDL durations. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** `H:MM:SS[.F]`; null for empty or `NOT_IMPLEMENTED`. */
export function parseTime(text: string | undefined): number | null {
  if (!text || text.toUpperCase() === 'NOT_IMPLEMENTED') return null;
  const parts = text.split(':');
  if (parts.length !== 3) return null;
  const [h, m, s] = parts.map(Number) as [number, number, number];
  if (![h, m, s].every(Number.isFinite)) return null;
  return h * 3600 + m * 60 + s;
}
