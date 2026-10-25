import { randomUUID } from 'node:crypto';
import type { StoredInsert } from './rack.js';

/** A whole rack kept under a name: plugins, order, switches, pinned knobs and settings. */
export interface RackPreset {
  id: string;
  name: string;
  inserts: StoredInsert[];
}

/** What the remotes see of a preset. */
export interface RackPresetSummary {
  id: string;
  name: string;
  /** The plugin names in order, for a subtitle. */
  plugins: string[];
}

const copy = (inserts: StoredInsert[]): StoredInsert[] => inserts.map((i) => ({ ...i, pinned: [...i.pinned] }));

export function presetOf(name: string, inserts: StoredInsert[], id: string = randomUUID()): RackPreset {
  return { id, name, inserts: copy(inserts) };
}

/**
 * The preset's inserts for the rack, under new ids: harbor-fx then creates the units and
 * restores the preset's settings into them (a running unit keeps its own).
 */
export function insertsOf(preset: RackPreset): StoredInsert[] {
  return copy(preset.inserts).map((i) => ({ ...i, id: randomUUID() }));
}

export function summaryOf(preset: RackPreset): RackPresetSummary {
  return { id: preset.id, name: preset.name, plugins: preset.inserts.map((i) => i.name) };
}

/** Trimmed, not empty, not longer than a chip can show. */
export function presetName(name: unknown): string | null {
  const trimmed = String(name ?? '').trim().slice(0, 40);
  return trimmed || null;
}
