import http from 'node:http';
import { URL } from 'node:url';

/**
 * Minimal UPnP AVTransport control point for network renderer output.
 */
export async function setAvTransportUri(
  controlUrl: string,
  uri: string,
  metadataXml = ''
): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeXml(uri)}</CurrentURI>
      <CurrentURIMetaData>${escapeXml(metadataXml)}</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;
  await soap(controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI', body);
}

export async function playRenderer(controlUrl: string): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;
  await soap(controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#Play', body);
}

export async function pauseRenderer(controlUrl: string): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Pause>
  </s:Body>
</s:Envelope>`;
  await soap(controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#Pause', body);
}

export async function setNextAvTransportUri(
  controlUrl: string,
  uri: string,
  metadataXml = ''
): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetNextAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <NextURI>${escapeXml(uri)}</NextURI>
      <NextURIMetaData>${escapeXml(metadataXml)}</NextURIMetaData>
    </u:SetNextAVTransportURI>
  </s:Body>
</s:Envelope>`;
  await soap(controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1#SetNextAVTransportURI', body);
}

export async function setRendererVolume(controlUrl: string, volume0to100: number): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>${Math.round(Math.max(0, Math.min(100, volume0to100)))}</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>`;
  await soap(controlUrl, 'urn:schemas-upnp-org:service:RenderingControl:1#SetVolume', body);
}

export async function fetchRendererDescription(location: string): Promise<{
  friendlyName: string;
  avTransportUrl: string | null;
  renderingControlUrl: string | null;
}> {
  const xml = await httpGet(location);
  const friendlyName = /<friendlyName>([^<]+)<\/friendlyName>/i.exec(xml)?.[1] ?? 'Renderer';
  const base = new URL(location);
  const av = extractControlUrl(xml, 'AVTransport');
  const rc = extractControlUrl(xml, 'RenderingControl');
  return {
    friendlyName,
    avTransportUrl: av ? new URL(av, base).toString() : null,
    renderingControlUrl: rc ? new URL(rc, base).toString() : null,
  };
}

function extractControlUrl(xml: string, service: string): string | null {
  const re = new RegExp(
    `<serviceType>[^<]*${service}[^<]*</serviceType>[\\s\\S]*?<controlURL>([^<]+)</controlURL>`,
    'i'
  );
  return re.exec(xml)?.[1] ?? null;
}

function soap(url: string, soapAction: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${soapAction}"`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) reject(new Error(`SOAP ${res.statusCode}`));
          else resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
