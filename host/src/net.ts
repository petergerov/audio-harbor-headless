import os from 'node:os';

/** Prefer a non-internal IPv4 address for LAN URLs (DLNA / media tokens). */
export function lanIp(): string {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const e of entries ?? []) {
      if (e.family === 'IPv4' && !e.internal) return e.address;
    }
  }
  return '127.0.0.1';
}

export function lanBaseUrl(port: number): string {
  return `http://${lanIp()}:${port}`;
}
