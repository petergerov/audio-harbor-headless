/** The little XML UPnP needs: escaping, SOAP answers, device descriptions. No dependency. */

export function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (whole, entity: string) => {
    const e = entity.toLowerCase();
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

/** Leaf element values by local name — what SOAP arguments need. The last one with a name wins. */
export function xmlLeaves(xml: string): Map<string, string> {
  const values = new Map<string, string>();
  const leaf = /<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?\1\s*>/g;
  for (const m of xml.matchAll(leaf)) {
    const value = unescapeXml(m[2]!).trim();
    if (value) values.set(m[1]!, value);
  }
  return values;
}

export interface DescribedService {
  serviceType: string;
  controlURL: string;
  eventSubURL: string;
  scpdURL: string;
}

export interface DeviceDescription {
  friendlyName: string;
  manufacturer: string;
  modelName: string;
  udn: string;
  urlBase: string | null;
  services: DescribedService[];
}

function firstTag(xml: string, name: string): string {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)<`, 'i').exec(xml);
  return m ? unescapeXml(m[1]!).trim() : '';
}

/** Root device fields (they come first) plus every service, embedded devices included. */
export function parseDeviceDescription(xml: string): DeviceDescription {
  const services: DescribedService[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?service(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?service\s*>/gi)) {
    const block = m[1]!;
    services.push({
      serviceType: firstTag(block, 'serviceType'),
      controlURL: firstTag(block, 'controlURL'),
      eventSubURL: firstTag(block, 'eventSubURL'),
      scpdURL: firstTag(block, 'SCPDURL'),
    });
  }
  return {
    friendlyName: firstTag(xml, 'friendlyName'),
    manufacturer: firstTag(xml, 'manufacturer'),
    modelName: firstTag(xml, 'modelName'),
    udn: firstTag(xml, 'UDN'),
    urlBase: firstTag(xml, 'URLBase') || null,
    services,
  };
}

/** "AVTransport" from "urn:schemas-upnp-org:service:AVTransport:1". */
export function serviceShortName(serviceType: string): string {
  const parts = serviceType.split(':');
  return parts.length >= 2 ? parts[parts.length - 2]! : serviceType;
}
