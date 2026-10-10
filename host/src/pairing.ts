import crypto from 'node:crypto';
import fs from 'node:fs';
import { pairingPath } from './paths.js';

export interface PairingState {
  pin: string;
  /** Base64 of 32 raw token bytes (Swift `Data` JSON form). */
  tokens: string[];
  /** Stable Bonjour / hello serverID (UUID). */
  serverId: string;
}

/** Wrong PINs in a row before pairing pauses, and for how long (as on the Mac). */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

let failedAttempts = 0;
let lockedUntil = 0;

function randomPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function mintTokenBase64(): string {
  return crypto.randomBytes(32).toString('base64');
}

function normalizeToken(token: string): string {
  // Accept standard or URL-safe base64; compare on normalized standard form.
  const cleaned = token.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(cleaned, 'base64').toString('base64');
  } catch {
    return token;
  }
}

export function loadPairing(): PairingState {
  const p = pairingPath();
  if (!fs.existsSync(p)) {
    const state: PairingState = {
      pin: randomPin(),
      tokens: [],
      serverId: crypto.randomUUID(),
    };
    savePairing(state);
    return state;
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<PairingState>;
  const state: PairingState = {
    pin: raw.pin ?? randomPin(),
    tokens: Array.isArray(raw.tokens) ? raw.tokens : [],
    serverId: raw.serverId ?? crypto.randomUUID(),
  };
  if (!raw.serverId) savePairing(state);
  return state;
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

/** Too many wrong PINs just now: every PIN is refused until the lockout ends. */
export function pairingLockedOut(): boolean {
  return Date.now() < lockedUntil;
}

export function pairWithPin(pin: string): string | null {
  if (pairingLockedOut()) return null;
  const state = loadPairing();
  if (pin !== state.pin) {
    failedAttempts += 1;
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      lockedUntil = Date.now() + LOCKOUT_MS;
      failedAttempts = 0;
    }
    return null;
  }
  failedAttempts = 0;
  const token = mintTokenBase64();
  state.tokens.push(token);
  state.pin = randomPin();
  savePairing(state);
  return token;
}

export function isAuthorized(token: string | undefined | null): boolean {
  if (!token) return false;
  const want = normalizeToken(token);
  const state = loadPairing();
  return state.tokens.some((t) => normalizeToken(t) === want);
}

/** Return an existing matching token, or null. */
export function existingToken(token: string): string | null {
  if (!isAuthorized(token)) return null;
  const want = normalizeToken(token);
  return loadPairing().tokens.find((t) => normalizeToken(t) === want) ?? null;
}
