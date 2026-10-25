import type { HttpClient } from './http';
import type { InsertMeter, PluginPreset, RackParam, RackPlugin, RackSnapshot } from './types';

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
  /** Typed in the plugin's own units ("-3.5 dB", "1.2 kHz"); the plugin reads it. */
  setParamText(id: string, param: string, text: string): Promise<RackParam | null>;
  setPinned(id: string, params: string[]): Promise<RackSnapshot>;
  /** Peak in and out of every insert. */
  meters(): Promise<Record<string, InsertMeter>>;
  /** The plugin's settings now (opaque), and back into it. */
  state(id: string): Promise<string>;
  setState(id: string, state: string): Promise<RackSnapshot>;
  /** Every parameter back to its default. */
  reset(id: string): Promise<RackSnapshot>;
  /** The plugin's own presets (its maker's, its preset folder's). */
  pluginPresets(id: string): Promise<PluginPreset[]>;
  loadPluginPreset(id: string, preset: string): Promise<RackSnapshot>;
  savePreset(name: string): Promise<RackSnapshot>;
  loadPreset(id: string): Promise<RackSnapshot>;
  /** The rack as it is now into the preset. */
  overwritePreset(id: string): Promise<RackSnapshot>;
  renamePreset(id: string, name: string): Promise<RackSnapshot>;
  deletePreset(id: string): Promise<RackSnapshot>;
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

  setParam(id: string, param: string, value: number): Promise<RackParam | null> {
    return this.putParam(id, param, { value });
  }

  setParamText(id: string, param: string, text: string): Promise<RackParam | null> {
    return this.putParam(id, param, { text });
  }

  private async putParam(id: string, param: string, body: { value: number } | { text: string }): Promise<RackParam | null> {
    const res = await this.http.put<{ param: RackParam | null }>(
      `/api/v1/rack/inserts/${encodeURIComponent(id)}/params/${encodeURIComponent(param)}`,
      body
    );
    return res.param;
  }

  setPinned(id: string, params: string[]): Promise<RackSnapshot> {
    return this.http.put(`/api/v1/rack/inserts/${encodeURIComponent(id)}/pinned`, { params });
  }

  async meters(): Promise<Record<string, InsertMeter>> {
    return (await this.http.get<{ meters: Record<string, InsertMeter> }>('/api/v1/rack/meters')).meters;
  }

  async state(id: string): Promise<string> {
    return (await this.http.get<{ state: string }>(`/api/v1/rack/inserts/${encodeURIComponent(id)}/state`)).state;
  }

  setState(id: string, state: string): Promise<RackSnapshot> {
    return this.http.put(`/api/v1/rack/inserts/${encodeURIComponent(id)}/state`, { state });
  }

  reset(id: string): Promise<RackSnapshot> {
    return this.http.post(`/api/v1/rack/inserts/${encodeURIComponent(id)}/reset`);
  }

  async pluginPresets(id: string): Promise<PluginPreset[]> {
    return (await this.http.get<{ presets: PluginPreset[] }>(`/api/v1/rack/inserts/${encodeURIComponent(id)}/presets`))
      .presets;
  }

  loadPluginPreset(id: string, preset: string): Promise<RackSnapshot> {
    return this.http.post(`/api/v1/rack/inserts/${encodeURIComponent(id)}/presets/load`, { preset });
  }

  savePreset(name: string): Promise<RackSnapshot> {
    return this.http.post('/api/v1/rack/presets', { name });
  }

  loadPreset(id: string): Promise<RackSnapshot> {
    return this.http.post(`/api/v1/rack/presets/${encodeURIComponent(id)}/load`);
  }

  overwritePreset(id: string): Promise<RackSnapshot> {
    return this.http.put(`/api/v1/rack/presets/${encodeURIComponent(id)}/save`, {});
  }

  renamePreset(id: string, name: string): Promise<RackSnapshot> {
    return this.http.put(`/api/v1/rack/presets/${encodeURIComponent(id)}`, { name });
  }

  deletePreset(id: string): Promise<RackSnapshot> {
    return this.http.delete(`/api/v1/rack/presets/${encodeURIComponent(id)}`);
  }
}
