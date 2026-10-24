import type { HttpClient } from './http';
import type { RackParam, RackPlugin, RackSnapshot } from './types';

/** The host's plugin rack. Every change answers with the rack after it. */
export interface RackApi {
  rack(): Promise<RackSnapshot>;
  /** Whole rack in or out for A/B. */
  setBypass(bypassed: boolean): Promise<RackSnapshot>;
  /** Plugins installed on the host; `rescan` looks for new ones. */
  plugins(rescan?: boolean): Promise<RackPlugin[]>;
  add(plugin: RackPlugin): Promise<RackSnapshot>;
  remove(id: string): Promise<RackSnapshot>;
  move(id: string, offset: -1 | 1): Promise<RackSnapshot>;
  setInsertBypass(id: string, bypassed: boolean): Promise<RackSnapshot>;
  params(id: string): Promise<RackParam[]>;
  /** The parameter as the plugin took it (its text for the new value). */
  setParam(id: string, param: string, value: number): Promise<RackParam | null>;
  setPinned(id: string, params: string[]): Promise<RackSnapshot>;
}

export class HttpRackApi implements RackApi {
  constructor(private readonly http: HttpClient) {}

  rack(): Promise<RackSnapshot> {
    return this.http.get('/api/v1/rack');
  }

  setBypass(bypassed: boolean): Promise<RackSnapshot> {
    return this.http.put('/api/v1/rack/bypass', { bypassed });
  }

  async plugins(rescan = false): Promise<RackPlugin[]> {
    const res = await this.http.get<{ plugins: RackPlugin[] }>(`/api/v1/rack/plugins${rescan ? '?rescan=1' : ''}`);
    return res.plugins;
  }

  add(plugin: RackPlugin): Promise<RackSnapshot> {
    return this.http.post('/api/v1/rack/inserts', { format: plugin.format, path: plugin.path, pluginId: plugin.id });
  }

  remove(id: string): Promise<RackSnapshot> {
    return this.http.delete(`/api/v1/rack/inserts/${encodeURIComponent(id)}`);
  }

  move(id: string, offset: -1 | 1): Promise<RackSnapshot> {
    return this.http.post(`/api/v1/rack/inserts/${encodeURIComponent(id)}/move`, { offset });
  }

  setInsertBypass(id: string, bypassed: boolean): Promise<RackSnapshot> {
    return this.http.put(`/api/v1/rack/inserts/${encodeURIComponent(id)}/bypass`, { bypassed });
  }

  async params(id: string): Promise<RackParam[]> {
    const res = await this.http.get<{ params: RackParam[] }>(`/api/v1/rack/inserts/${encodeURIComponent(id)}/params`);
    return res.params;
  }

  async setParam(id: string, param: string, value: number): Promise<RackParam | null> {
    const res = await this.http.put<{ param: RackParam | null }>(
      `/api/v1/rack/inserts/${encodeURIComponent(id)}/params/${encodeURIComponent(param)}`,
      { value }
    );
    return res.param;
  }

  setPinned(id: string, params: string[]): Promise<RackSnapshot> {
    return this.http.put(`/api/v1/rack/inserts/${encodeURIComponent(id)}/pinned`, { params });
  }
}
