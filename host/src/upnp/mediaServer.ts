import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { Catalogue } from '../library/catalogue.js';
import { lanBaseUrl, lanIp } from '../net.js';

export interface DlnaOptions {
  port: number;
  friendlyName: string;
  catalogue: Catalogue;
  roots: string[];
}

/**
 * Minimal DLNA MediaServer: device description + ContentDirectory browse
 * of albums/artists/directories, and HTTP Range file serving.
 */
export async function startDlnaServer(opts: DlnaOptions): Promise<http.Server> {
  const udn = `uuid:harbor-${opts.port}`;
  const base = lanBaseUrl(opts.port);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);

    if (url.pathname === '/description.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(deviceDescription(opts.friendlyName, udn, base));
      return;
    }

    if (url.pathname === '/cds/control' && req.method === 'POST') {
      const body = await readBody(req);
      const result = handleCds(body, opts, base);
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(soapEnvelope(result));
      return;
    }

    if (url.pathname.startsWith('/media/')) {
      const filePath = decodeURIComponent(url.pathname.slice('/media/'.length));
      if (!isUnderRoots(filePath, opts.roots) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      return streamFile(req, res, filePath);
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '0.0.0.0', resolve));
  void advertiseSsdp(opts.port, udn, base);
  return server;
}

function isUnderRoots(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((r) => resolved.startsWith(path.resolve(r) + path.sep) || resolved === path.resolve(r));
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

function handleCds(body: string, opts: DlnaOptions, base: string): string {
  if (body.includes('Browse')) {
    const objectId = /<ObjectID>([^<]*)<\/ObjectID>/.exec(body)?.[1] ?? '0';
    const didl = browseDidl(objectId, opts, base);
    return `<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>${escapeXml(didl)}</Result>
      <NumberReturned>1</NumberReturned>
      <TotalMatches>1</TotalMatches>
      <UpdateID>1</UpdateID>
    </u:BrowseResponse>`;
  }
  if (body.includes('GetSortCapabilities')) {
    return `<u:GetSortCapabilitiesResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <SortCaps></SortCaps>
    </u:GetSortCapabilitiesResponse>`;
  }
  return `<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
    <Result>&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"&gt;&lt;/DIDL-Lite&gt;</Result>
    <NumberReturned>0</NumberReturned>
    <TotalMatches>0</TotalMatches>
    <UpdateID>1</UpdateID>
  </u:BrowseResponse>`;
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
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

function browseDidl(objectId: string, opts: DlnaOptions, base: string): string {
  if (objectId === '0') {
    return `<?xml version="1.0"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <container id="albums" parentID="0" restricted="1"><dc:title>Albums</dc:title><upnp:class>object.container</upnp:class></container>
  <container id="artists" parentID="0" restricted="1"><dc:title>Artists</dc:title><upnp:class>object.container</upnp:class></container>
  <container id="directories" parentID="0" restricted="1"><dc:title>Directories</dc:title><upnp:class>object.container</upnp:class></container>
</DIDL-Lite>`;
  }
  if (objectId === 'albums') {
    const albums = opts.catalogue.albums().slice(0, 200);
    const items = albums
      .map(
        (a) =>
          `<container id="album:${a.id}" parentID="albums" restricted="1"><dc:title>${escapeXml(a.title)}</dc:title><upnp:artist>${escapeXml(a.artist)}</upnp:artist><upnp:class>object.container.album.musicAlbum</upnp:class></container>`
      )
      .join('');
    return `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${items}</DIDL-Lite>`;
  }
  if (objectId === 'artists') {
    const artists = opts.catalogue.artists().slice(0, 200);
    const items = artists
      .map(
        (a) =>
          `<container id="artist:${escapeXml(a.name)}" parentID="artists" restricted="1"><dc:title>${escapeXml(a.name)}</dc:title><upnp:class>object.container.person.musicArtist</upnp:class></container>`
      )
      .join('');
    return `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${items}</DIDL-Lite>`;
  }
  if (objectId.startsWith('artist:')) {
    const name = objectId.slice('artist:'.length);
    const tracks = opts.catalogue.artistTracks(name);
    return trackDidl(tracks, objectId, base);
  }
  if (objectId.startsWith('album:')) {
    const id = objectId.slice('album:'.length);
    const tracks = opts.catalogue.albumTracks(id);
    return trackDidl(tracks, objectId, base);
  }
  return `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"></DIDL-Lite>`;
}

function estimateBitrate(t: {
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  fileSize: number | null;
  durationSecs: number | null;
  format: string;
}): number | null {
  if (t.fileSize != null && t.durationSecs != null && t.durationSecs > 0) {
    return Math.round((t.fileSize * 8) / t.durationSecs);
  }
  if (t.sampleRate && t.bitDepth && t.channels) {
    return t.sampleRate * t.bitDepth * t.channels;
  }
  return null;
}

function dlnaPn(mime: string, format: string): string {
  if (format === 'flac' || mime === 'audio/flac') return 'FLAC';
  if (format === 'mp3' || mime === 'audio/mpeg') return 'MP3';
  if (format === 'wav' || mime === 'audio/wav') return 'LPCM';
  if (mime === 'audio/mp4') return 'AAC_ISO';
  return '';
}

function trackDidl(
  tracks: ReturnType<Catalogue['albumTracks']>,
  parentId: string,
  base: string
): string {
  const items = tracks
    .map((t) => {
      const media = `${base}/media/${encodeURIComponent(t.cataloguePath)}`;
      const mime = mimeForPath(t.cataloguePath);
      const dur =
        t.durationSecs != null
          ? ` duration="${escapeXml(formatDidlDuration(t.durationSecs))}"`
          : '';
      const bitrate = estimateBitrate(t);
      const br = bitrate != null ? ` bitrate="${bitrate}"` : '';
      const sr = t.sampleRate != null ? ` sampleFrequency="${t.sampleRate}"` : '';
      const bits = t.bitDepth != null ? ` bitsPerSample="${t.bitDepth}"` : '';
      const ch = t.channels != null ? ` nrAudioChannels="${t.channels}"` : '';
      const size = t.fileSize != null ? ` size="${t.fileSize}"` : '';
      const pn = dlnaPn(mime, t.format);
      const features = pn
        ? `DLNA.ORG_PN=${pn};DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`
        : 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
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
  return `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${items}</DIDL-Lite>`;
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

function streamFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
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
  res.writeHead(200, {
    'Content-Length': st.size,
    'Content-Type': 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function advertiseSsdp(port: number, udn: string, base: string): Promise<void> {
  try {
    const dgram = await import('node:dgram');
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const host = lanIp();
    socket.bind(1900, () => {
      try {
        socket.setMulticastInterface(host);
        socket.addMembership('239.255.255.250', host);
      } catch {
        // ignore multicast join failures
      }
    });
    const msg = Buffer.from(
      [
        'NOTIFY * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'CACHE-CONTROL: max-age=1800',
        `LOCATION: ${base}/description.xml`,
        'NT: upnp:rootdevice',
        'NTS: ssdp:alive',
        `USN: ${udn}::upnp:rootdevice`,
        'SERVER: AudioHarbor/0.1 UPnP/1.0',
        '',
        '',
      ].join('\r\n')
    );
    setInterval(() => {
      socket.send(msg, 1900, '239.255.255.250');
    }, 30000).unref();
    // Also answer M-SEARCH briefly
    socket.on('message', (buf, rinfo) => {
      const text = buf.toString('utf8');
      if (!/M-SEARCH/i.test(text)) return;
      if (!/ssdp:all|MediaServer|rootdevice/i.test(text)) return;
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
    void port;
  } catch {
    // SSDP optional
  }
}
