import type { HttpClient } from './http';

export interface PairingSetup {
  /** False: this network's remotes connect without a code. */
  required: boolean;
  firstRun: boolean;
  pin?: string;
}

export interface AuthApi {
  /** Trades the host's PIN for a token. */
  pair(pin: string): Promise<string>;
  /** Whether the host wants a code at all; before any device has paired, its PIN. */
  setup(): Promise<PairingSetup>;
}

export class HttpAuthApi implements AuthApi {
  constructor(private readonly http: HttpClient) {}

  async pair(pin: string): Promise<string> {
    return (await this.http.post<{ token: string }>('/api/v1/pair', { pin })).token;
  }

  setup(): Promise<PairingSetup> {
    return this.http.get('/api/v1/pair/setup');
  }
}
