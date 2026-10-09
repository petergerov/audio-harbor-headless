/** Where the pairing token lives. */
export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export class LocalTokenStore implements TokenStore {
  constructor(private readonly key = 'harbor.token') {}

  get(): string | null {
    return localStorage.getItem(this.key);
  }

  set(token: string | null): void {
    if (token) localStorage.setItem(this.key, token);
    else localStorage.removeItem(this.key);
  }
}

/** A failed request, with the host's `error` text as message when it sent one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** JSON over fetch, authorised with the pairing token. */
export class HttpClient {
  constructor(private readonly tokens: TokenStore) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const token = this.tokens.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new ApiError(await errorText(res), res.status);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return text || res.statusText;
}
