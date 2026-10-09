#!/usr/bin/env node
import qrcode from 'qrcode-terminal';
import { buildServer, loadPairing, printPairingInfo, rotatePin } from './api/server.js';
import { loadConfig, saveConfig } from './config.js';
import { engineVersion } from './engine/bridge.js';
import { Catalogue } from './library/catalogue.js';
import { lanBaseUrl } from './net.js';
import { PlaybackService } from './playback/service.js';
import { KeepAwake } from './power.js';
import { startBonjourRemote } from './remote/bonjour.js';
import { Mdns } from './remote/mdns.js';
import { MediaHttpServer } from './upnp/mediaHttp.js';
import { startDlnaServer } from './upnp/mediaServer.js';
import { NetworkPlayer } from './upnp/networkPlayer.js';
import { RendererBrowser } from './upnp/ssdp.js';

async function main(): Promise<void> {
  const [cmd = 'serve', ...rest] = process.argv.slice(2);

  if (cmd === 'pair') {
    const state = rest.includes('--rotate') ? rotatePin() : loadPairing();
    console.log(`Pairing PIN: ${state.pin}`);
    return;
  }

  if (cmd === 'rescan') {
    const cfg = loadConfig();
    const catalogue = new Catalogue();
    const result = await catalogue.scanRoots(cfg.library.roots);
    catalogue.close();
    console.log(`Scanned ${result.scanned}, indexed ${result.indexed}`);
    return;
  }

  if (cmd !== 'serve') {
    console.log(`Usage: harbor <serve|pair|rescan>`);
    process.exit(1);
  }

  let cfg = loadConfig();
  const getConfig = () => cfg;
  const persist = (next: typeof cfg) => {
    cfg = next;
    saveConfig(cfg);
  };

  const catalogue = new Catalogue();
  if (cfg.library.roots.length) {
    const result = await catalogue.scanRoots(cfg.library.roots);
    console.log(`Library: scanned ${result.scanned}, updated ${result.indexed}`);
  }

  // Network players (UPnP / DLNA renderers) show up in the output list like a DAC.
  const browser = new RendererBrowser();
  browser.start();
  const network = new NetworkPlayer(
    browser,
    new MediaHttpServer(cfg.network.media_port),
    catalogue,
    new KeepAwake('Playing to a network player')
  );

  const playback = new PlaybackService(catalogue, getConfig, persist, browser, network);
  playback.applyConfigOutput();

  const app = await buildServer({ catalogue, playback, getConfig });
  const address = await app.listen({ host: cfg.server.host, port: cfg.server.port });

  // mDNS: this host as http://audioharbor.local:<port> — nothing to type, and a new DHCP
  // address does not break a saved home-screen app. Also carries the Bonjour remote.
  const mdns = cfg.server.local_hostname || cfg.remote.bonjour_enabled ? new Mdns() : null;
  const localName = mdns && cfg.server.local_hostname ? await mdns.claim(cfg.server.local_hostname) : null;
  if (mdns && localName) {
    // The web remote as a Bonjour service; its address records make the name resolve, so
    // a clash of service names must not take them down (the name itself was probed).
    mdns.publish({ name: cfg.server.name, type: 'http', port: cfg.server.port, probe: false });
  }
  if (mdns) {
    const shutdown = () => {
      setTimeout(() => process.exit(0), 1000).unref();
      void mdns.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  const lan = lanBaseUrl(cfg.server.port);
  const url = localName ? `http://${localName}:${cfg.server.port}` : lan;
  console.log(`Audio Harbor Headless listening on ${address}`);
  console.log(`Engine: ${engineVersion()}`);
  console.log(`Open on iPhone: ${url}`);
  if (localName) console.log(`            or: ${lan}`);
  if (localName && localName !== mdns?.wanted) {
    console.log(`(${mdns?.wanted} is taken by another device on the network)`);
  }
  printPairingInfo();
  qrcode.generate(url, { small: true });

  if (cfg.sharing.enabled) {
    await startDlnaServer({
      port: cfg.sharing.port,
      friendlyName: cfg.sharing.friendly_name,
      catalogue,
      roots: cfg.library.roots,
      dsdLevel: cfg.output.dsd_pcm_level,
    });
    console.log(`DLNA music server on port ${cfg.sharing.port}`);
  }

  if (mdns && cfg.remote.bonjour_enabled) {
    await startBonjourRemote({
      port: cfg.remote.bonjour_port,
      name: cfg.server.name,
      playback,
      catalogue,
      getConfig,
      mdns,
    });
    console.log(`Bonjour remote _audioharbor._tcp on port ${cfg.remote.bonjour_port}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
