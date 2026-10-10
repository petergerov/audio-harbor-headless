import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Catalogue } from '../library/catalogue.js';
import { resolveDstDffPlaybackPath } from '../library/dstDff.js';
import { resolveSacdPlaybackPath, SACD_MARKER } from '../library/sacd.js';
import { lanBaseUrl, lanIp } from '../net.js';
import type { Track } from '../types.js';
import { byteRange, DLNA_FEATURES } from './mediaHttp.js';
import { WavStream } from './networkMedia.js';

export interface DlnaOptions {
  port: number;
  friendlyName: string;
  catalogue: Catalogue;
  /** The library roots as they are now. */
  roots: () => string[];
  /** DSD→PCM gain for WAV transcoding (0 / 3 / 6), as it is now. */
  dsdLevel: () => 0 | 3 | 6;
  /** A media stream started or ended. */
  onStreams?: () => void;
}

/** A running DLNA server. */
export interface DlnaServer {
  /** Media responses streaming now. */
  readonly activeStreams: number;
  /** Says goodbye over SSDP, drops open streams and stops listening. */
  close(): Promise<void>;
}

const CHUNK = 256 * 1024;
const DIDL_NS =
  'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"';

/**
 * DLNA MediaServer: device description, ContentDirectory Browse / Search,
 * HTTP Range file serving, and on-the-fly WAV for DSD (and SACD / DST DFF).
 */
export async function startDlnaServer(opts: DlnaOptions): Promise<DlnaServer> {
  const udn = `uuid:harbor-${opts.port}`;
  const base = lanBaseUrl(opts.port);
  let streams = 0;
  const countStream = (res: http.ServerResponse) => {
    streams += 1;
    opts.onStreams?.();
    res.once('close', () => {
      streams -= 1;
      opts.onStreams?.();
    });
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', base);

      if (url.pathname === '/description.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(deviceDescription(opts.friendlyName, udn, base));
        return;
      }

      if (url.pathname === '/cds/scpd.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(cdsScpd());
        return;
      }

      if (url.pathname === '/cds/control' && req.method === 'POST') {
        const body = await readBody(req);
        const result = handleCds(body, opts, base);
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(soapEnvelope(result));
        return;
      }

      if (url.pathname.startsWith('/media/wav/')) {
        const cataloguePath = decodeURIComponent(url.pathname.slice('/media/wav/'.length));
        if (!isPlayablePath(cataloguePath, opts.roots())) {
          res.writeHead(404);
          res.end();
          return;
        }
        countStream(res);
        return streamWav(req, res, cataloguePath, opts.dsdLevel());
      }

      if (url.pathname.startsWith('/media/')) {
        const cataloguePath = decodeURIComponent(url.pathname.slice('/media/'.length));
        if (!isPlayablePath(cataloguePath, opts.roots())) {
          res.writeHead(404);
          res.end();
          return;
        }
        const source = await resolvePlayPath(cataloguePath);
        if (!fs.existsSync(source)) {
          res.writeHead(404);
          res.end();
          return;
        }
        countStream(res);
        return streamFile(req, res, source, mimeForPath(cataloguePath));
      }

      res.writeHead(404);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const stopSsdp = await advertiseSsdp(udn, base);
  return {
    get activeStreams() {
      return streams;
    },
    close: async () => {
      stopSsdp();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function isPlayablePath(cataloguePath: string, roots: string[]): boolean {
  const filePath = cataloguePath.includes(SACD_MARKER)
    ? cataloguePath.slice(0, cataloguePath.indexOf(SACD_MARKER))
    : cataloguePath;
  return isUnderRoots(filePath, roots);
}

function isUnderRoots(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((r) => resolved.startsWith(path.resolve(r) + path.sep) || resolved === path.resolve(r));
}

async function resolvePlayPath(cataloguePath: string): Promise<string> {
  if (cataloguePath.includes(SACD_MARKER)) return resolveSacdPlaybackPath(cataloguePath);
  return resolveDstDffPlaybackPath(cataloguePath);
}

function needsWavTranscode(cataloguePath: string, format?: string): boolean {
  if (cataloguePath.includes(SACD_MARKER)) return true;
  const ext = path.extname(cataloguePath).toLowerCase();
  if (ext === '.dsf' || ext === '.dff' || ext === '.iso') return true;
  return format === 'dsf' || format === 'dff' || format === 'sacd';
}

function deviceDescription(name: string, udn: string, base: string): string {
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${escapeXml(base)}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${escapeXml(name)}</friendlyName>
    <manufacturer>Audio Harbor</manufacturer>
    <modelName>Audio Harbor Headless</modelName>
    <UDN>${udn}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>/cds/control</controlURL>
        <eventSubURL>/cds/event</eventSubURL>
        <SCPDURL>/cds/scpd.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

function cdsScpd(): string {
  return `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>Browse</name></action>
    <action><name>Search</name></action>
    <action><name>GetSearchCapabilities</name></action>
    <action><name>GetSortCapabilities</name></action>
    <action><name>GetSystemUpdateID</name></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;
}

function handleCds(body: string, opts: DlnaOptions, base: string): string {
  if (body.includes('GetSearchCapabilities')) {
    return `<u:GetSearchCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <SearchCaps>dc:title,upnp:artist,upnp:album,dc:creator</SearchCaps>
    </u:GetSearchCapabilitiesResponse>`;
  }
  if (body.includes('GetSortCapabilities')) {
    return `<u:GetSortCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <SortCaps></SortCaps>
    </u:GetSortCapabilitiesResponse>`;
  }
  if (body.includes('GetSystemUpdateID')) {
    return `<u:GetSystemUpdateIDResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Id>1</Id>
    </u:GetSystemUpdateIDResponse>`;
  }
  if (body.includes('Search')) {
    const criteria = soapArg(body, 'SearchCriteria') ?? '';
    const requested = Number(soapArg(body, 'RequestedCount') ?? '50');
    const query = searchQuery(criteria);
    const tracks = opts.catalogue.search(query, Number.isFinite(requested) && requested > 0 ? requested : 50);
    const didl = trackDidl(tracks, 'search', base);
    return searchResponse(didl, tracks.length, tracks.length);
  }
  if (body.includes('Browse')) {
    const objectId = soapArg(body, 'ObjectID') ?? '0';
    const { didl, count } = browseDidl(objectId, opts, base);
    return browseResponse(didl, count, count);
  }
  return browseResponse(emptyDidl(), 0, 0);
}

function soapArg(body: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i').exec(
    body
  );
  if (!m) return null;
  return m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** Pull a free-text query out of UPnP SearchCriteria (`dc:title contains "foo"`). */
function searchQuery(criteria: string): string {
  const quoted = /"([^"]+)"/.exec(criteria);
  if (quoted?.[1]) return quoted[1];
  const plain = criteria.replace(/[=<>()]/g, ' ').replace(/\b(and|or|contains|derivedfrom|exists|true|false|dc:\w+|upnp:\w+)\b/gi, ' ');
  return plain.replace(/\s+/g, ' ').trim();
}

function browseResponse(didl: string, returned: number, total: number): string {
  return `<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>${escapeXml(didl)}</Result>
      <NumberReturned>${returned}</NumberReturned>
      <TotalMatches>${total}</TotalMatches>
      <UpdateID>1</UpdateID>
    </u:BrowseResponse>`;
}

function searchResponse(didl: string, returned: number, total: number): string {
  return `<u:SearchResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>${escapeXml(didl)}</Result>
      <NumberReturned>${returned}</NumberReturned>
      <TotalMatches>${total}</TotalMatches>
      <UpdateID>1</UpdateID>
    </u:SearchResponse>`;
}

function emptyDidl(): string {
  return `<?xml version="1.0"?><DIDL-Lite ${DIDL_NS}></DIDL-Lite>`;
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath.includes(SACD_MARKER) ? '.dff' : filePath).toLowerCase();
  switch (ext) {
    case '.flac':
      return 'audio/flac';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.aiff':
    case '.aif':
      return 'audio/aiff';
    case '.m4a':
    case '.mp4':
    case '.aac':
      return 'audio/mp4';
    case '.dsf':
      return 'audio/x-dsf';
    case '.dff':
      return 'audio/x-dff';
    default:
      return 'application/octet-stream';
  }
}

function browseDidl(
  objectId: string,
  opts: DlnaOptions,
  base: string
): { didl: string; count: number } {
  if (objectId === '0') {
    const items = [
      container('albums', '0', 'Albums', 'object.container'),
      container('artists', '0', 'Artists', 'object.container'),
      container('directories', '0', 'Directories', 'object.container'),
    ].join('');
    return { didl: wrapDidl(items), count: 3 };
  }
  if (objectId === 'albums') {
    const albums = opts.catalogue.albums().slice(0, 500);
    const items = albums
      .map((a) =>
        container(`album:${a.id}`, 'albums', a.title, 'object.container.album.musicAlbum', a.artist)
      )
      .join('');
    return { didl: wrapDidl(items), count: albums.length };
  }
  if (objectId === 'artists') {
    const artists = opts.catalogue.artists().slice(0, 500);
    const items = artists
      .map((a) => container(`artist:${a.name}`, 'artists', a.name, 'object.container.person.musicArtist'))
      .join('');
    return { didl: wrapDidl(items), count: artists.length };
  }
  if (objectId === 'directories') {
    return folderDidl(opts, base, null, 'directories');
  }
  if (objectId.startsWith('dir:')) {
    const folder = objectId.slice('dir:'.length);
    return folderDidl(opts, base, folder, objectId);
  }
  if (objectId.startsWith('artist:')) {
    const name = objectId.slice('artist:'.length);
    const tracks = opts.catalogue.artistTracks(name);
    return { didl: trackDidl(tracks, objectId, base), count: tracks.length };
  }
  if (objectId.startsWith('album:')) {
    const id = objectId.slice('album:'.length);
    const tracks = opts.catalogue.albumTracks(id);
    return { didl: trackDidl(tracks, objectId, base), count: tracks.length };
  }
  return { didl: emptyDidl(), count: 0 };
}

function folderDidl(
  opts: DlnaOptions,
  base: string,
  folderPath: string | null,
  parentId: string
): { didl: string; count: number } {
  const entries = opts.catalogue.browseFolder(opts.roots(), folderPath);
  const parts: string[] = [];
  const tracks: Track[] = [];
  for (const e of entries) {
    if (e.isDirectory) {
      parts.push(container(`dir:${e.path}`, parentId, e.name, 'object.container.storageFolder'));
      continue;
    }
    if (e.track) {
      tracks.push(e.track);
      continue;
    }
    // Unscanned audio under Folders — still list it so a client can pull it.
    const ext = path.extname(e.path).toLowerCase();
    tracks.push({
      cataloguePath: e.path,
      id: e.path,
      title: e.name,
      artist: '',
      album: '',
      albumArtist: '',
      trackNumber: null,
      discNumber: null,
      year: null,
      durationSecs: null,
      sampleRate: null,
      bitDepth: null,
      channels: null,
      format:
        ext === '.dsf'
          ? 'dsf'
          : ext === '.dff'
            ? 'dff'
            : ext === '.flac'
              ? 'flac'
              : ext === '.mp3'
                ? 'mp3'
                : 'unknown',
      artworkHash: null,
      fileSize: null,
      labels: [],
    });
  }
  const trackXml = trackItems(tracks, parentId, base);
  const all = parts.join('') + trackXml;
  return { didl: wrapDidl(all), count: parts.length + tracks.length };
}

function container(
  id: string,
  parentId: string,
  title: string,
  upnpClass: string,
  artist?: string
): string {
  const artistTag = artist != null ? `<upnp:artist>${escapeXml(artist)}</upnp:artist>` : '';
  return `<container id="${escapeXml(id)}" parentID="${escapeXml(parentId)}" restricted="1"><dc:title>${escapeXml(title)}</dc:title>${artistTag}<upnp:class>${upnpClass}</upnp:class></container>`;
}

function wrapDidl(items: string): string {
  return `<?xml version="1.0"?><DIDL-Lite ${DIDL_NS}>${items}</DIDL-Lite>`;
}

function estimateBitrate(t: {
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  fileSize: number | null;
  durationSecs: number | null;
}): number | null {
  if (t.fileSize != null && t.durationSecs != null && t.durationSecs > 0) {
    return Math.round((t.fileSize * 8) / t.durationSecs);
  }
  if (t.sampleRate && t.bitDepth && t.channels) {
    return t.sampleRate * t.bitDepth * t.channels;
  }
  return null;
}

function trackDidl(tracks: Track[], parentId: string, base: string): string {
  return wrapDidl(trackItems(tracks, parentId, base));
}

function trackItems(tracks: Track[], parentId: string, base: string): string {
  return tracks
    .map((t) => {
      const wav = needsWavTranscode(t.cataloguePath, t.format);
      const media = wav
        ? `${base}/media/wav/${encodeURIComponent(t.cataloguePath)}`
        : `${base}/media/${encodeURIComponent(t.cataloguePath)}`;
      const mime = wav ? 'audio/wav' : mimeForPath(t.cataloguePath);
      const dur =
        t.durationSecs != null
          ? ` duration="${escapeXml(formatDidlDuration(t.durationSecs))}"`
          : '';
      const bitrate = wav
        ? t.sampleRate && t.channels
          ? t.sampleRate * 24 * t.channels
          : null
        : estimateBitrate(t);
      const br = bitrate != null ? ` bitrate="${bitrate}"` : '';
      const sr = t.sampleRate != null && !wav ? ` sampleFrequency="${t.sampleRate}"` : '';
      const bits = wav ? ' bitsPerSample="24"' : t.bitDepth != null ? ` bitsPerSample="${t.bitDepth}"` : '';
      const ch = t.channels != null ? ` nrAudioChannels="${t.channels}"` : '';
      const size = !wav && t.fileSize != null ? ` size="${t.fileSize}"` : '';
      const pn = wav ? 'LPCM' : t.format === 'flac' ? 'FLAC' : t.format === 'mp3' ? 'MP3' : '';
      const features = pn
        ? `DLNA.ORG_PN=${pn};${DLNA_FEATURES};DLNA.ORG_CI=${wav ? 1 : 0}`
        : `${DLNA_FEATURES};DLNA.ORG_CI=${wav ? 1 : 0}`;
      const protocolInfo = `http-get:*:${mime}:${features}`;
      return `<item id="track:${escapeXml(t.id)}" parentID="${escapeXml(parentId)}" restricted="1">
          <dc:title>${escapeXml(t.title)}</dc:title>
          <upnp:artist>${escapeXml(t.artist)}</upnp:artist>
          <upnp:album>${escapeXml(t.album)}</upnp:album>
          <upnp:class>object.item.audioItem.musicTrack</upnp:class>
          <res protocolInfo="${escapeXml(protocolInfo)}"${dur}${br}${sr}${bits}${ch}${size}>${media}</res>
        </item>`;
    })
    .join('');
}

function formatDidlDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}.000`;
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${inner}</s:Body>
</s:Envelope>`;
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function streamFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  mime: string
): void {
  const st = fs.statSync(filePath);
  const headers: Record<string, string | number> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': DLNA_FEATURES,
  };
  const range = req.headers.range ? byteRange(req.headers.range, st.size) : null;
  if (req.headers.range && !range) {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
    res.end();
    return;
  }
  const start = range?.[0] ?? 0;
  const end = range?.[1] ?? st.size - 1;
  headers['Content-Length'] = end - start + 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

async function streamWav(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cataloguePath: string,
  dsdLevel: 0 | 3 | 6
): Promise<void> {
  const source = await resolvePlayPath(cataloguePath);
  const wav = await WavStream.open(source, { wifi: false, dsdLevel });
  const size = wav.totalSize;
  const headers: Record<string, string | number> = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': `DLNA.ORG_PN=LPCM;${DLNA_FEATURES};DLNA.ORG_CI=1`,
  };
  const range = req.headers.range ? byteRange(req.headers.range, size) : null;
  if (req.headers.range && !range) {
    wav.close();
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const start = range?.[0] ?? 0;
  const end = range?.[1] ?? size - 1;
  headers['Content-Length'] = Math.max(0, end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) {
    wav.close();
    res.end();
    return;
  }
  const close = () => wav.close();
  res.on('close', close);
  try {
    await pipeline(Readable.from(wavChunks(wav, start, end + 1)), res);
  } catch {
    res.destroy();
  } finally {
    close();
  }
}

async function* wavChunks(wav: WavStream, start: number, end: number): AsyncGenerator<Buffer> {
  let offset = start;
  while (offset < end) {
    const chunk = await wav.read(offset, Math.min(CHUNK, end - offset));
    if (!chunk.length) throw new Error('stream closed');
    offset += chunk.length;
    yield chunk;
  }
}

/** Announces the server over SSDP and answers searches; the returned function says goodbye. */
async function advertiseSsdp(udn: string, base: string): Promise<() => void> {
  try {
    const dgram = await import('node:dgram');
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const host = lanIp();
    const notify = (nts: 'ssdp:alive' | 'ssdp:byebye') =>
      Buffer.from(
        [
          'NOTIFY * HTTP/1.1',
          'HOST: 239.255.255.250:1900',
          'CACHE-CONTROL: max-age=1800',
          `LOCATION: ${base}/description.xml`,
          'NT: upnp:rootdevice',
          `NTS: ${nts}`,
          `USN: ${udn}::upnp:rootdevice`,
          'SERVER: AudioHarbor/0.1 UPnP/1.0',
          '',
          '',
        ].join('\r\n')
      );
    const msg = notify('ssdp:alive');
    // Sends fail while the network is down; announcing is retried by the timer.
    socket.on('error', () => undefined);
    socket.bind(1900, () => {
      try {
        socket.setMulticastInterface(host);
        socket.addMembership('239.255.255.250', host);
      } catch {
        // ignore multicast join failures
      }
      socket.send(msg, 1900, '239.255.255.250');
    });
    const timer = setInterval(() => {
      socket.send(msg, 1900, '239.255.255.250');
    }, 30000);
    timer.unref();
    socket.on('message', (buf, rinfo) => {
      const text = buf.toString('utf8');
      if (!/M-SEARCH/i.test(text)) return;
      if (!/ssdp:all|MediaServer|rootdevice|ContentDirectory/i.test(text)) return;
      const reply = Buffer.from(
        [
          'HTTP/1.1 200 OK',
          'CACHE-CONTROL: max-age=1800',
          'EXT:',
          `LOCATION: ${base}/description.xml`,
          'SERVER: AudioHarbor/0.1 UPnP/1.0',
          'ST: urn:schemas-upnp-org:device:MediaServer:1',
          `USN: ${udn}::urn:schemas-upnp-org:device:MediaServer:1`,
          '',
          '',
        ].join('\r\n')
      );
      socket.send(reply, rinfo.port, rinfo.address);
    });
    return () => {
      clearInterval(timer);
      const close = () => {
        try {
          socket.close();
        } catch {
          // already closed
        }
      };
      try {
        socket.send(notify('ssdp:byebye'), 1900, '239.255.255.250', close);
      } catch {
        close();
      }
    };
  } catch {
    // SSDP optional
    return () => undefined;
  }
}
