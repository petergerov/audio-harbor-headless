import type { HttpClient } from './http';

export interface AuthApi {
  /** Trades the host's PIN for a token. */
  pair(pin: string): Promise<string>;
  /** Before any device has paired, the host hands out its PIN. */
  setup(): Promise<{ firstRun: boolean; pin?: string }>;
}

export class HttpAuthApi implements AuthApi {
  constructor(private readonly http: HttpClient) {}

  async pair(pin: string): Promise<string> {
    return (await this.http.post<{ token: string }>('/api/v1/pair', { pin })).token;
  }

  setup(): Promise<{ firstRun: boolean; pin?: string }> {
    return this.http.get('/api/v1/pair/setup');
  }
}
