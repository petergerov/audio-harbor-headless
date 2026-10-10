import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function dataDir(): string {
  const dir = path.join(os.homedir(), '.audio-harbor-headless');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return path.join(dataDir(), 'config.toml');
}

export function cataloguePath(): string {
  return path.join(dataDir(), 'catalogue.sqlite');
}

export function artworkDir(): string {
  const dir = path.join(dataDir(), 'artwork');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pairingPath(): string {
  return path.join(dataDir(), 'pairing.json');
}

export function exampleConfigPath(): string {
  // host/dist/paths.js → repo root
  return path.resolve(__dirname, '../../config.example.toml');
}

export function hostPackagePath(): string {
  // host/dist/paths.js → host/package.json
  return path.resolve(__dirname, '../package.json');
}

export function webDistPath(): string {
  // host/dist/paths.js → web/dist
  return path.resolve(__dirname, '../../web/dist');
}
