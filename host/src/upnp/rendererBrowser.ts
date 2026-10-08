import dgram from 'node:dgram';
import type { OutputDevice } from '../types.js';
import { enrichRenderers, type DiscoveredRenderer } from './rendererOutput.js';

export interface RendererDiscoveryResult {
  devices: DiscoveredRenderer[];
  locations: Map<string, string>;
}

/**
 * SSDP M-SEARCH for MediaRenderer devices, then fetch descriptions.
 */
export async function startRendererBrowser(): Promise<RendererDiscoveryResult> {
  const locations = new Map<string, string>();
  const found = new Map<string, OutputDevice>();

  await new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve();
    }, 1500);

    socket.on('message', (msg) => {
      const text = msg.toString('utf8');
      if (!/MediaRenderer/i.test(text)) return;
      const loc = /LOCATION:\s*(.+)/i.exec(text)?.[1]?.trim();
      const usn = /USN:\s*(.+)/i.exec(text)?.[1]?.trim() ?? loc ?? 'unknown';
      const udn = usn.split('::')[0] ?? usn;
      const uid = `upnp:${udn}`;
      if (found.has(uid) || !loc) return;
      locations.set(uid, loc);
      found.set(uid, {
        uid,
        name: `Network player`,
        kind: 'network',
        supportsExclusive: false,
        supportsDop: false,
        isExternal: false,
      });
    });

    socket.bind(() => {
      const search = Buffer.from(
        [
          'M-SEARCH * HTTP/1.1',
          'HOST: 239.255.255.250:1900',
          'MAN: "ssdp:discover"',
          'MX: 2',
          'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
          '',
          '',
        ].join('\r\n')
      );
      socket.send(search, 1900, '239.255.255.250');
    });

    timer.unref();
  });

  const devices = await enrichRenderers([...found.values()], locations);
  return { devices, locations };
}
