import type { TokenStore } from './http';

export interface ArtworkApi {
  /** URL for `<img src>`: the token rides in the query (`+` percent-encoded). */
  url(hash: string | null | undefined): string | null;
  /** A blob URL fetched with the Authorization header — for when the query token fails. */
  objectUrl(hash: string): Promise<string>;
}

export class HttpArtworkApi implements ArtworkApi {
  private readonly blobs = new Map<string, string>();

  constructor(private readonly tokens: TokenStore) {}

  url(hash: string | null | undefined): string | null {
    if (!hash) return null;
    const token = this.tokens.get() ?? '';
    return `/api/v1/artwork/${encodeURIComponent(hash)}?token=${encodeURIComponent(token)}`;
  }

  async objectUrl(hash: string): Promise<string> {
    const hit = this.blobs.get(hash);
    if (hit) return hit;
    const headers: Record<string, string> = {};
    const token = this.tokens.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api/v1/artwork/${encodeURIComponent(hash)}`, { headers });
    if (!res.ok) throw new Error('artwork');
    const url = URL.createObjectURL(await res.blob());
    this.blobs.set(hash, url);
    return url;
  }
}
