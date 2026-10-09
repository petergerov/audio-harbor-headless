import type { HttpClient } from './http';
import type { BrowseItem, LibraryScope } from './types';

export interface LibraryApi {
  /** Albums / artists / folders, or what is inside one (`path`: album id, artist name, folder). */
  browse(scope: LibraryScope, path: string | null): Promise<BrowseItem[]>;
  search(query: string): Promise<BrowseItem[]>;
}

export class HttpLibraryApi implements LibraryApi {
  constructor(private readonly http: HttpClient) {}

  async browse(scope: LibraryScope, path: string | null): Promise<BrowseItem[]> {
    const at = path ? `&path=${encodeURIComponent(path)}` : '';
    return (await this.http.get<{ items: BrowseItem[] }>(`/api/v1/browse?scope=${scope}${at}`)).items;
  }

  async search(query: string): Promise<BrowseItem[]> {
    return (await this.http.get<{ items: BrowseItem[] }>(`/api/v1/search?q=${encodeURIComponent(query)}`))
      .items;
  }
}
