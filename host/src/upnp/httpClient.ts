import http from 'node:http';

export interface HttpResult {
  status: number;
  body: string;
}

export class HttpTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`No answer from ${new URL(url).host} within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'HttpTimeoutError';
  }
}

/**
 * One HTTP request to a device on the LAN. Lenient parser and no keep-alive: UPnP stacks in
 * amplifiers and TVs are often quirky about both.
 */
export function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          ...(payload ? { 'Content-Length': String(payload.length) } : {}),
          Connection: 'close',
        },
        agent: false,
        insecureHTTPParser: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.setTimeout(options.timeoutMs, () => req.destroy(new HttpTimeoutError(url, options.timeoutMs)));
    req.on('error', reject);
    req.end(payload);
  });
}
