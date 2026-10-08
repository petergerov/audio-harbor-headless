#!/usr/bin/env node
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { buildServer, loadPairing, printPairingInfo, rotatePin } from './api/server.js';
import { loadConfig, saveConfig } from './config.js';
import { engineVersion } from './engine/bridge.js';
import { Catalogue } from './library/catalogue.js';
import { PlaybackService } from './playback/service.js';
import { startBonjourRemote } from './remote/bonjour.js';
import { startDlnaServer } from './upnp/mediaServer.js';
import { startRendererBrowser } from './upnp/rendererBrowser.js';

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

  const playback = new PlaybackService(catalogue, getConfig, persist);
  playback.applyConfigOutput();

  const app = await buildServer({ catalogue, playback, getConfig });
  const address = await app.listen({ host: cfg.server.host, port: cfg.server.port });

  const lan = pickLanUrl(cfg.server.port);
  console.log(`Audio Harbor Headless listening on ${address}`);
  console.log(`Engine: ${engineVersion()}`);
  console.log(`Open on iPhone: ${lan}`);
  printPairingInfo();
  qrcode.generate(lan, { small: true });

  if (cfg.sharing.enabled) {
    await startDlnaServer({
      port: cfg.sharing.port,
      friendlyName: cfg.sharing.friendly_name,
      catalogue,
      roots: cfg.library.roots,
    });
    console.log(`DLNA music server on port ${cfg.sharing.port}`);
  }

  const discovery = await startRendererBrowser();
  playback.setNetworkDevices(discovery.devices);
  if (discovery.devices.length) {
    console.log(`UPnP renderers: ${discovery.devices.map((d) => d.name).join(', ')}`);
  }

  if (cfg.remote.bonjour_enabled) {
    await startBonjourRemote({
      port: cfg.remote.bonjour_port,
      name: cfg.server.name,
      playback,
      catalogue,
      getConfig,
    });
    console.log(`Bonjour remote _audioharbor._tcp on port ${cfg.remote.bonjour_port}`);
  }
}

function pickLanUrl(port: number): string {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const e of entries ?? []) {
      if (e.family === 'IPv4' && !e.internal) {
        return `http://${e.address}:${port}`;
      }
    }
  }
  return `http://127.0.0.1:${port}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
