import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  engineEvents,
  engineFxRequest,
  engineFxSetBypass,
  engineFxTouch,
  engineGetState,
  engineHasRack,
  fxBinaryPath,
} from './engine/bridge.js';
import { appRootPath, dataDir } from './paths.js';
import { insertsOf, presetName, presetOf, summaryOf, type RackPreset, type RackPresetSummary } from './rackPresets.js';

/** A plugin installed on this machine, as harbor-fx describes it. */
export interface RackPlugin {
  format: 'clap' | 'lv2';
  path: string;
  /** CLAP plugin id or LV2 URI. */
  id: string;
  name: string;
  vendor: string;
  version: string;
  features: string[];
  /** A stereo effect — what the rack takes. */
  stereo: boolean;
  /** Shipped with Audio Harbor and picked for a job ("Graphic EQ"); listed first. */
  role?: string;
}

/**
 * The plugins the Linux and macOS packages ship (LSP Plugins as one CLAP file, built without
 * UI by packaging/build-plugins.sh), in the order the picker shows them.
 */
const INCLUDED: Array<[id: string, role: string]> = [
  ['in.lsp-plug.graph_equalizer_x16_stereo', 'Graphic EQ'],
  ['in.lsp-plug.para_equalizer_x16_stereo', 'Parametric EQ'],
  ['in.lsp-plug.mb_compressor_stereo', 'Mastering Compressor'],
  ['in.lsp-plug.limiter_stereo', 'Mastering Limiter'],
  ['in.lsp-plug.loud_comp_stereo', 'Loudness Compensation'],
];

/** Where the shipped plugins sit in an install; harbor-fx finds them through CLAP_PATH. */
export function bundledPluginDir(): string {
  return path.join(appRootPath(), 'plugins', 'clap');
}

/** One parameter, in the plugin's own units, with the plugin's own text for the value. */
export interface RackParam {
  id: string;
  name: string;
  module?: string;
  min: number;
  max: number;
  default: number;
  value: number;
  text: string;
  stepped: boolean;
  isBypass?: boolean;
  /** Set by the plugin only (a meter). */
  readOnly?: boolean;
  /** A stepped parameter's values with the plugin's text for each. */
  options?: Array<{ value: number; text: string }>;
}

/** Peak level into and out of an insert, dBFS; out − in is what it does to the level. */
export interface InsertMeter {
  in: number;
  out: number;
}

/** A new value: as a number in the plugin's units, or as text the plugin reads ("-3.5 dB"). */
export type ParamInput = { value: number } | { text: string };

export interface RackInsertView {
  id: string;
  /** CLAP id or LV2 URI — the remote picks a panel for the plugins it knows. */
  pluginId: string;
  name: string;
  vendor: string;
  format: string;
  bypassed: boolean;
  /** The plugin is loaded in harbor-fx; active once a track set its rate. */
  loaded: boolean;
  error: string | null;
  /** Up to six parameters shown on the rack sheet. */
  pinned: RackParam[];
}

export interface RackSnapshot {
  /** This host can run plugins (harbor-fx built, not Windows yet). */
  available: boolean;
  /** Whole rack bypassed for A/B. */
  bypassed: boolean;
  inserts: RackInsertView[];
  /** What leaves the rack: "Exclusive · FX", "Bypassed", "Network · no FX", … */
  path: { label: string; lit: boolean; note: string };
  /** Compensated latency of the chain. */
  latencyMs: number;
  /** Why the rack is not running (harbor-fx crashed, gave up), or null. */
  error: string | null;
  presets: RackPresetSummary[];
  /** The preset the rack was loaded from; `edited` once it changed since. */
  activePreset: string | null;
  edited: boolean;
}

export interface StoredInsert {
  id: string;
  format: RackPlugin['format'];
  path: string;
  pluginId: string;
  name: string;
  vendor: string;
  bypassed: boolean;
  /** The plugin's own state (base64), as harbor-fx saved it. */
  state: string | null;
  pinned: string[];
}

interface StoredRack {
  inserts: StoredInsert[];
  bypassed: boolean;
  presets: RackPreset[];
  activePreset: string | null;
  edited: boolean;
}

interface InsertStatus {
  id: string;
  loaded: boolean;
  active: boolean;
  error?: string;
}

interface ScanCache {
  entries: Record<string, { mtimeMs: number; plugins: RackPlugin[]; error?: string }>;
}

export const MAX_PINNED = 6;
const STATE_SAVE_MS = 1500;
const DESCRIBE_TIMEOUT_MS = 20000;

export class RackError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function rackPath(): string {
  return path.join(dataDir(), 'rack.json');
}

function scanCachePath(): string {
  return path.join(dataDir(), 'plugins.json');
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Runs harbor-fx in a tool mode and parses the JSON line it prints. */
function runFx(args: string[], timeout: number): Promise<{ plugins?: RackPlugin[]; error?: string }> {
  const bin = fxBinaryPath();
  if (!bin) return Promise.reject(new Error('harbor-fx is not built'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout) => {
      const line = String(stdout).trim().split('\n').pop() ?? '';
      if (line.startsWith('{')) {
        try {
          resolve(JSON.parse(line));
          return;
        } catch {
          // fall through
        }
      }
      reject(err ?? new Error('harbor-fx printed nothing'));
    });
  });
}

/**
 * The plugin rack: which plugins sit in it, in what order, switched how, with what settings —
 * kept in rack.json and sent to harbor-fx through the engine. harbor-fx holds the running
 * units; the settings are read back from it a moment after they change.
 */
export class Rack extends EventEmitter {
  private stored: StoredRack = { inserts: [], bypassed: false, presets: [], activePreset: null, edited: false };
  private status = new Map<string, InsertStatus>();
  private scan: Promise<RackPlugin[]> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(private isNetworkOutput: () => boolean) {
    super();
  }

  get available(): boolean {
    return engineHasRack();
  }

  async start(): Promise<void> {
    // Before harbor-fx first starts (it inherits the environment) and before any scan.
    const bundled = bundledPluginDir();
    if (fs.existsSync(bundled)) {
      const paths = (process.env.CLAP_PATH ?? '').split(path.delimiter).filter(Boolean);
      if (!paths.includes(bundled)) process.env.CLAP_PATH = [bundled, ...paths].join(path.delimiter);
    }
    const loaded = readJson<Partial<StoredRack>>(rackPath(), {});
    this.stored = {
      inserts: Array.isArray(loaded.inserts) ? loaded.inserts : [],
      bypassed: Boolean(loaded.bypassed),
      presets: Array.isArray(loaded.presets) ? loaded.presets : [],
      activePreset: typeof loaded.activePreset === 'string' ? loaded.activePreset : null,
      edited: Boolean(loaded.edited),
    };
    engineFxSetBypass(this.stored.bypassed);
    engineEvents.on('fx', (ev: { running?: boolean; stopped?: boolean }) => this.onFxEvent(ev));
    if (this.stored.inserts.length && this.available) await this.pushChain();
  }

  /** Settings of every plugin to rack.json now (quit). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveStates();
  }

  async snapshot(): Promise<RackSnapshot> {
    const st = engineGetState();
    const fx = st?.fx;
    const inserts: RackInsertView[] = [];
    for (const ins of this.stored.inserts) {
      const status = this.status.get(ins.id);
      inserts.push({
        id: ins.id,
        pluginId: ins.pluginId,
        name: ins.name,
        vendor: ins.vendor,
        format: ins.format,
        bypassed: ins.bypassed,
        loaded: status?.loaded ?? false,
        error: status?.error ?? null,
        pinned: ins.pinned.length && status?.loaded ? await this.pinnedParams(ins) : [],
      });
    }
    const exclusive = st?.effectiveMode === 'exclusive' || st?.effectiveMode === 'dop';
    const processing = inserts.some((i) => i.loaded && !i.bypassed);
    const rate = st?.streamRate || 0;
    return {
      available: this.available,
      bypassed: this.stored.bypassed,
      inserts,
      path: this.pathLabel(exclusive, processing, inserts.length > 0),
      latencyMs: rate && fx?.latency ? Math.round((fx.latency / rate) * 1000) : 0,
      error: fx?.error ?? null,
      presets: this.stored.presets.map(summaryOf),
      activePreset: this.stored.activePreset,
      edited: this.stored.edited,
    };
  }

  private pathLabel(exclusive: boolean, processing: boolean, hasInserts: boolean): RackSnapshot['path'] {
    if (this.isNetworkOutput() && hasInserts) {
      return {
        label: 'Network · no FX',
        lit: false,
        note: 'A network player gets the file, or converted PCM, without the plugins.',
      };
    }
    if (processing && !this.stored.bypassed) {
      return {
        label: exclusive ? 'Exclusive · FX' : 'Shared · FX',
        lit: true,
        note: exclusive
          ? "The DAC stays exclusive at the file's rate; the plugins change the sound."
          : 'Plugins process the shared output.',
      };
    }
    if (hasInserts) {
      return {
        label: 'Bypassed',
        lit: false,
        note: this.stored.bypassed
          ? 'The whole rack is bypassed for A/B. Only an empty rack is bit-perfect or plays DoP.'
          : 'Every insert is bypassed. Only an empty rack is bit-perfect or plays DoP.',
      };
    }
    return exclusive
      ? { label: 'Bit-perfect', lit: false, note: 'Empty rack — the file reaches the DAC untouched.' }
      : { label: 'Shared', lit: false, note: 'Empty rack.' };
  }

  /** Installed plugins (cached; harbor-fx describes new or changed files). */
  async plugins(rescan = false): Promise<RackPlugin[]> {
    if (!this.available) return [];
    if (!this.scan || rescan) {
      this.scan = this.scanPlugins(rescan).catch((err) => {
        this.scan = null;
        throw err;
      });
    }
    return this.scan;
  }

  private async scanPlugins(rescan: boolean): Promise<RackPlugin[]> {
    const cache = rescan ? { entries: {} } : readJson<ScanCache>(scanCachePath(), { entries: {} });
    const listed = (await runFx(['--list'], DESCRIBE_TIMEOUT_MS)).plugins ?? [];
    const next: ScanCache = { entries: {} };
    for (const item of listed) {
      if (item.id) {
        // LV2: lilv already knows the plugin.
        const entry = next.entries[item.path] ?? { mtimeMs: 0, plugins: [] };
        entry.plugins.push(item);
        next.entries[item.path] = entry;
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(item.path).mtimeMs;
      } catch {
        continue;
      }
      const known = cache.entries[item.path];
      if (known && known.mtimeMs === mtimeMs) {
        next.entries[item.path] = known;
        continue;
      }
      try {
        const described = await runFx(['--describe', item.format, item.path], DESCRIBE_TIMEOUT_MS);
        next.entries[item.path] = { mtimeMs, plugins: described.plugins ?? [], error: described.error };
      } catch (err) {
        // A plugin that crashes or hangs while describing itself stays out of the list.
        next.entries[item.path] = { mtimeMs, plugins: [], error: err instanceof Error ? err.message : String(err) };
      }
    }
    writeJson(scanCachePath(), next);
    const bundled = bundledPluginDir();
    const rank = (p: RackPlugin) => (p.role ? INCLUDED.findIndex(([id]) => id === p.id) : INCLUDED.length);
    return Object.values(next.entries)
      .flatMap((e) => e.plugins)
      .map((p) => {
        const role = p.path.startsWith(bundled) ? INCLUDED.find(([id]) => id === p.id)?.[1] : undefined;
        return role ? { ...p, role } : p;
      })
      .sort((a, b) => rank(a) - rank(b) || a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
  }

  async addInsert(format: string, pluginPath: string, pluginId: string): Promise<RackSnapshot> {
    this.requireRack();
    const plugin = (await this.plugins()).find(
      (p) => p.format === format && p.path === pluginPath && p.id === pluginId
    );
    if (!plugin) throw new RackError('That plugin is not installed on this host', 404);
    if (!plugin.stereo) throw new RackError('Only stereo effects (2 in, 2 out) go in the rack');
    const insert: StoredInsert = {
      id: randomUUID(),
      format: plugin.format,
      path: plugin.path,
      pluginId: plugin.id,
      name: plugin.name,
      vendor: plugin.vendor,
      bypassed: false,
      state: null,
      pinned: [],
    };
    this.stored.inserts.push(insert);
    await this.pushChain();
    if (this.status.get(insert.id)?.loaded) insert.pinned = await this.defaultPins(insert);
    this.markEdited();
    this.persist();
    return this.changed();
  }

  async removeInsert(id: string): Promise<RackSnapshot> {
    await this.saveStates();
    this.stored.inserts = this.stored.inserts.filter((i) => i.id !== this.insert(id).id);
    this.status.delete(id);
    await this.pushChain();
    this.markEdited();
    this.persist();
    return this.changed();
  }

  async moveInsert(id: string, offset: number): Promise<RackSnapshot> {
    const from = this.stored.inserts.indexOf(this.insert(id));
    const to = from + Math.sign(offset);
    if (to < 0 || to >= this.stored.inserts.length) return this.snapshot();
    const [ins] = this.stored.inserts.splice(from, 1);
    this.stored.inserts.splice(to, 0, ins);
    await this.pushChain();
    this.markEdited();
    this.persist();
    return this.changed();
  }

  async setInsertBypass(id: string, bypassed: boolean): Promise<RackSnapshot> {
    const ins = this.insert(id);
    ins.bypassed = bypassed;
    await engineFxRequest({ cmd: 'setBypass', id, bypassed });
    this.markEdited();
    this.persist();
    return this.changed();
  }

  /** Whole rack in or out for A/B, without a gap. */
  async setBypass(bypassed: boolean): Promise<RackSnapshot> {
    this.stored.bypassed = bypassed;
    engineFxSetBypass(bypassed);
    this.persist();
    return this.changed();
  }

  async params(id: string): Promise<RackParam[]> {
    this.insert(id);
    const reply = await engineFxRequest<{ ok: boolean; params?: RackParam[]; error?: string }>({ cmd: 'params', id });
    if (!reply.ok) throw new RackError(reply.error ?? 'The plugin did not answer', 409);
    return reply.params ?? [];
  }

  async setParam(id: string, param: string, input: ParamInput): Promise<RackParam | null> {
    this.insert(id);
    if ('value' in input && !Number.isFinite(input.value)) throw new RackError('value must be a number');
    if ('text' in input && !input.text.trim()) throw new RackError('text must not be empty');
    const reply = await engineFxRequest<{ ok: boolean; param?: RackParam; error?: string }>({
      cmd: 'setParam',
      id,
      param,
      ...input,
    });
    if (!reply.ok) throw new RackError(reply.error ?? 'The plugin refused the value');
    // Rendered with a short lead for a few seconds, so the change is heard soon.
    engineFxTouch();
    this.settingsChanged();
    return reply.param ?? null;
  }

  /** Peak in and out of every insert. */
  async meters(): Promise<Record<string, InsertMeter>> {
    if (!this.available || !this.stored.inserts.length) return {};
    const reply = await engineFxRequest<{ ok: boolean; meters?: Record<string, InsertMeter> }>({ cmd: 'meters' });
    return reply.meters ?? {};
  }

  /** The plugin's settings as it holds them now (base64), to compare against or undo to. */
  async state(id: string): Promise<string> {
    this.insert(id);
    const reply = await engineFxRequest<{ ok: boolean; state?: string; error?: string }>({ cmd: 'getState', id });
    if (!reply.ok || !reply.state) throw new RackError(reply.error ?? 'The plugin keeps no settings', 409);
    return reply.state;
  }

  async setState(id: string, state: string): Promise<RackSnapshot> {
    this.insert(id);
    const reply = await engineFxRequest<{ ok: boolean; error?: string }>({ cmd: 'setState', id, state });
    if (!reply.ok) throw new RackError(reply.error ?? 'The plugin did not take those settings');
    engineFxTouch();
    this.settingsChanged();
    return this.snapshot();
  }

  /** Every parameter of the plugin back to its default. */
  async resetParams(id: string): Promise<RackSnapshot> {
    this.insert(id);
    const reply = await engineFxRequest<{ ok: boolean; error?: string }>({ cmd: 'resetParams', id });
    if (!reply.ok) throw new RackError(reply.error ?? 'The plugin did not reset');
    engineFxTouch();
    this.settingsChanged();
    return this.snapshot();
  }

  // --- presets: the whole rack under a name ---

  async savePreset(name: unknown): Promise<RackSnapshot> {
    const clean = presetName(name);
    if (!clean) throw new RackError('A preset needs a name');
    if (!this.stored.inserts.length) throw new RackError('The rack is empty — add a plugin first');
    await this.saveStates();
    const preset = presetOf(clean, this.stored.inserts);
    this.stored.presets.push(preset);
    this.stored.activePreset = preset.id;
    this.stored.edited = false;
    this.persist();
    return this.changed();
  }

  /** The rack as it is now, into the active preset. */
  async overwritePreset(id: string): Promise<RackSnapshot> {
    const index = this.presetIndex(id);
    await this.saveStates();
    this.stored.presets[index] = presetOf(this.stored.presets[index].name, this.stored.inserts, id);
    this.stored.activePreset = id;
    this.stored.edited = false;
    this.persist();
    return this.changed();
  }

  async loadPreset(id: string): Promise<RackSnapshot> {
    this.requireRack();
    const preset = this.stored.presets[this.presetIndex(id)];
    this.stored.inserts = insertsOf(preset);
    await this.pushChain();
    this.stored.activePreset = id;
    this.stored.edited = false;
    this.persist();
    return this.changed();
  }

  async renamePreset(id: string, name: unknown): Promise<RackSnapshot> {
    const clean = presetName(name);
    if (!clean) throw new RackError('A preset needs a name');
    this.stored.presets[this.presetIndex(id)].name = clean;
    this.persist();
    return this.changed();
  }

  async deletePreset(id: string): Promise<RackSnapshot> {
    this.stored.presets.splice(this.presetIndex(id), 1);
    if (this.stored.activePreset === id) {
      this.stored.activePreset = null;
      this.stored.edited = false;
    }
    this.persist();
    return this.changed();
  }

  async setPinned(id: string, params: string[]): Promise<RackSnapshot> {
    const ins = this.insert(id);
    ins.pinned = [...new Set(params.map(String))].slice(0, MAX_PINNED);
    this.persist();
    return this.changed();
  }

  // --- internals ---

  private insert(id: string): StoredInsert {
    const ins = this.stored.inserts.find((i) => i.id === id);
    if (!ins) throw new RackError('No such insert', 404);
    return ins;
  }

  private presetIndex(id: string): number {
    const index = this.stored.presets.findIndex((p) => p.id === id);
    if (index < 0) throw new RackError('No such preset', 404);
    return index;
  }

  /** The rack no longer matches the preset it came from. */
  private markEdited(): void {
    if (this.stored.activePreset && !this.stored.edited) this.stored.edited = true;
  }

  /** A plugin's settings moved: remembered shortly, the remotes told, the preset edited. */
  private settingsChanged(): void {
    const wasEdited = this.stored.edited;
    this.markEdited();
    if (this.stored.edited !== wasEdited) this.persist();
    this.scheduleStateSave();
    this.emitChanged();
  }

  private requireRack(): void {
    if (!this.available) throw new RackError('This host cannot run plugins', 409);
  }

  /** The chain to harbor-fx, settings included (harbor-fx keeps running units as they are). */
  private async pushChain(): Promise<void> {
    if (!this.available) return;
    const reply = await engineFxRequest<{ ok: boolean; inserts?: InsertStatus[]; error?: string }>({
      cmd: 'setChain',
      inserts: this.stored.inserts.map((i) => ({
        id: i.id,
        format: i.format,
        path: i.path,
        pluginId: i.pluginId,
        name: i.name,
        bypassed: i.bypassed,
        state: i.state,
      })),
    });
    this.status.clear();
    for (const s of reply.inserts ?? []) this.status.set(s.id, s);
  }

  private async pinnedParams(ins: StoredInsert): Promise<RackParam[]> {
    try {
      const all = await this.params(ins.id);
      return ins.pinned.map((id) => all.find((p) => p.id === id)).filter((p): p is RackParam => !!p);
    } catch {
      return [];
    }
  }

  /** A small plugin shows all its knobs; a large one starts with none pinned. */
  private async defaultPins(ins: StoredInsert): Promise<string[]> {
    try {
      const knobs = (await this.params(ins.id)).filter((p) => !p.isBypass && !p.readOnly);
      return knobs.length <= 12 ? knobs.slice(0, MAX_PINNED).map((p) => p.id) : [];
    } catch {
      return [];
    }
  }

  private scheduleStateSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveStates().catch(() => {});
    }, STATE_SAVE_MS);
  }

  /** Plugin settings from harbor-fx into rack.json, and into the chain it gets after a crash. */
  private async saveStates(): Promise<void> {
    if (!this.available || !this.stored.inserts.length) return;
    const reply = await engineFxRequest<{ ok: boolean; states?: Record<string, string> }>({ cmd: 'getStates' });
    if (!reply.ok || !reply.states) return;
    let changed = false;
    for (const ins of this.stored.inserts) {
      const state = reply.states[ins.id];
      if (state && state !== ins.state) {
        ins.state = state;
        changed = true;
      }
    }
    if (!changed) return;
    this.persist();
    await this.pushChain();
  }

  private onFxEvent(ev: { running?: boolean; stopped?: boolean }): void {
    if (ev.running === false && !ev.stopped && this.stored.inserts.length) {
      // A plugin took harbor-fx down: start it again with the chain (the engine counts crashes).
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.pushChain()
          .catch(() => {})
          .finally(() => this.emitChanged());
      }, 500);
    }
    this.emitChanged();
  }

  private persist(): void {
    writeJson(rackPath(), this.stored);
  }

  private async changed(): Promise<RackSnapshot> {
    const snap = await this.snapshot();
    this.emit('change', snap);
    return snap;
  }

  /** Coalesced: a dragged knob sends many values, the remotes need a few snapshots. */
  private emitChanged(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      void this.changed().catch(() => {});
    }, 150);
  }
}
