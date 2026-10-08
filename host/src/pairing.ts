import crypto from 'node:crypto';
import fs from 'node:fs';
import { pairingPath } from './paths.js';

export interface PairingState {
  pin: string;
  tokens: string[];
}

function randomPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function loadPairing(): PairingState {
  const p = pairingPath();
  if (!fs.existsSync(p)) {
    const state: PairingState = { pin: randomPin(), tokens: [] };
    savePairing(state);
    return state;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as PairingState;
}

export function savePairing(state: PairingState): void {
  fs.writeFileSync(pairingPath(), JSON.stringify(state, null, 2));
}

export function rotatePin(): PairingState {
  const state = loadPairing();
  state.pin = randomPin();
  savePairing(state);
  return state;
}

export function pairWithPin(pin: string): string | null {
  const state = loadPairing();
  if (pin !== state.pin) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  state.tokens.push(token);
  // Rotate PIN after successful pair
  state.pin = randomPin();
  savePairing(state);
  return token;
}

export function isAuthorized(token: string | undefined | null): boolean {
  if (!token) return false;
  const state = loadPairing();
  return state.tokens.includes(token);
}
