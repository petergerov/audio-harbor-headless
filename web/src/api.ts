const TOKEN_KEY = 'harbor.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (!token) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

export async function api<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function connectWs(onMessage: (msg: { type: string; payload: unknown }) => void): void {
  const token = getToken();
  if (!token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/v1/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => {
    try {
      onMessage(JSON.parse(String(ev.data)));
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    setTimeout(() => connectWs(onMessage), 2000);
  };
}
