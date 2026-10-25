import { RackError, type Rack, type RackInsertView, type RackSnapshot } from '../rack.js';

/** Swift RackInsertDTO. */
export interface RemoteRackInsert {
  id: string;
  name: string;
  /** "FabFilter · VST3", or why the plugin is not running. */
  detail: string | null;
  isBypassed: boolean;
  isLoaded: boolean;
}

/** Swift RackSnapshot (protocol 4): the rack as the iOS app shows it. */
export interface RemoteRackSnapshot {
  inserts: RemoteRackInsert[];
  isBypassed: boolean;
  path: string;
  isLit: boolean;
  pathNote: string;
  presets: Array<{ id: string; name: string }>;
  activePresetID: string | null;
  isPresetModified: boolean;
  loadingPresetID: string | null;
}

const FORMAT_NAMES: Record<string, string> = { clap: 'CLAP', vst3: 'VST3', au: 'AU', lv2: 'LV2' };

function detailOf(insert: RackInsertView): string {
  if (insert.error) return insert.error;
  const format = FORMAT_NAMES[insert.format] ?? insert.format.toUpperCase();
  if (!insert.vendor) return format;
  // LSP names its CLAP builds "LSP CLAP" already.
  return insert.vendor.toUpperCase().includes(format) ? insert.vendor : `${insert.vendor} · ${format}`;
}

export function remoteRackSnapshot(snap: RackSnapshot): RemoteRackSnapshot {
  return {
    inserts: snap.inserts.map((insert) => ({
      id: insert.id,
      name: insert.name,
      detail: detailOf(insert),
      isBypassed: insert.bypassed,
      isLoaded: insert.loaded,
    })),
    isBypassed: snap.bypassed,
    path: snap.path.label,
    isLit: snap.path.lit,
    pathNote: snap.path.note,
    presets: snap.presets.map(({ id, name }) => ({ id, name })),
    activePresetID: snap.activePreset,
    isPresetModified: snap.edited,
    loadingPresetID: snap.loadingPreset,
  };
}

/** Swift sends a UUID in capitals; the host made it in small letters. */
function sameId(a: string, b: unknown): boolean {
  return typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * The rack for the Bonjour remote, by the Mac's rules (`RemoteRackSnapshot` in Audio Harbor):
 * the app switches the whole rack or one insert and loads presets; editing stays on the host
 * and the web remote.
 */
export class RemoteRack {
  constructor(private readonly rack: Rack) {}

  async snapshot(): Promise<RemoteRackSnapshot> {
    return remoteRackSnapshot(await this.rack.snapshot());
  }

  watch(listener: (snapshot: RemoteRackSnapshot) => void): () => void {
    const onChange = (snap: RackSnapshot) => listener(remoteRackSnapshot(snap));
    this.rack.on('change', onChange);
    return () => this.rack.off('change', onChange);
  }

  /** Swift RackPatch: `insertID` null for the whole rack. Null on success, else why not. */
  async apply(patch: unknown): Promise<string | null> {
    const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
    if (typeof p.isBypassed !== 'boolean') return 'The patch needs isBypassed';
    if (p.insertID === undefined || p.insertID === null) {
      await this.rack.setBypass(p.isBypassed);
      return null;
    }
    const snap = await this.rack.snapshot();
    const insert = snap.inserts.find((i) => sameId(i.id, p.insertID));
    if (!insert) return 'That insert is no longer in the rack';
    if (!insert.loaded) return 'That plugin is not loaded on the host';
    if (snap.bypassed) return 'The rack is bypassed — put it back in circuit first';
    return this.attempt(() => this.rack.setInsertBypass(insert.id, p.isBypassed as boolean));
  }

  /**
   * Starts the swap and answers at once, as the Mac does; the `rack` topic follows while it
   * loads. Null once started, else why not.
   */
  async loadPreset(id: unknown): Promise<string | null> {
    const snap = await this.rack.snapshot();
    if (!snap.available) return 'This host cannot run plugins';
    const preset = snap.presets.find((p) => sameId(p.id, id));
    if (!preset) return 'That preset is no longer on the host';
    if (snap.loadingPreset) return 'Another preset is still loading';
    const loading = this.rack.loadPreset(preset.id);
    loading.catch((err) => console.warn('Rack preset could not load:', err instanceof Error ? err.message : err));
    return null;
  }

  private async attempt(change: () => Promise<unknown>): Promise<string | null> {
    try {
      await change();
      return null;
    } catch (err) {
      if (err instanceof RackError) return err.message;
      throw err;
    }
  }
}
