import type { RackParam } from '../../api/types';

/** A section of a plugin's parameters: its main controls, or one band / filter / module. */
export interface ParamGroup {
  key: string;
  label: string;
  params: RackParam[];
  /** The switch that brings the band into play ("Band 1 Used", "Filter type 3"); none for Main. */
  activator: RackParam | null;
  /** In play: no activator, or the activator is on. */
  active: boolean;
}

const MAIN = '';

/**
 * Which parameter of a band switches it on, most specific first: Pro-Q's "Used" beats its
 * "Enabled"; LSP's "Filter type N" is on unless "Off"; "Band on N", "… band enable N".
 */
const ACTIVATORS = [/\bused\b/i, /^filter type\b/i, /\b(on|enable|enabled)\b/i];

const OFF = /^(off|unused|none)$/i;

/** "Gain 3" → "3", "Band gain 1.6K" → "1.6K". */
function trailingToken(name: string): string | null {
  return /\s(\d+(?:\.\d+)?K?)$/i.exec(name)?.[1] ?? null;
}

function keyOf(param: RackParam): string {
  if (param.module) return param.module;
  const token = trailingToken(param.name);
  return token === null ? MAIN : `#${token}`;
}

/**
 * How numbered bands read. Centre frequencies ("16", "1.6K" — not counting up by one) become
 * "16 Hz", "1.6 kHz"; a count from 0 becomes Band 1, 2, …; a count from 1 stays as it is.
 */
function bandNamer(tokens: string[]): (token: string) => string {
  const numbers = tokens.map((t) => Number.parseFloat(t));
  const counting = tokens.every((t) => /^\d+$/.test(t)) && Math.max(...numbers) - Math.min(...numbers) + 1 === tokens.length;
  if (!counting) return (t) => (/k$/i.test(t) ? `${t.slice(0, -1)} kHz` : `${t} Hz`);
  const offset = Math.min(...numbers) === 0 ? 1 : 0;
  return (t) => `Band ${Number(t) + offset}`;
}

function activatorOf(params: RackParam[]): RackParam | null {
  for (const pattern of ACTIVATORS) {
    const found = params.find((p) => (p.options?.length ?? 0) >= 2 && pattern.test(p.name));
    if (found) return found;
  }
  return null;
}

/** A name inside its group, without what the group already says: "Gain 3" → "Gain", "Band 1 Gain" → "Gain". */
export function shortName(param: RackParam, group: ParamGroup): string {
  if (group.key.startsWith('#')) {
    const token = group.key.slice(1);
    return param.name.endsWith(` ${token}`) ? param.name.slice(0, -token.length - 1) : param.name;
  }
  if (group.key && param.name.startsWith(`${group.key} `)) return param.name.slice(group.key.length + 1);
  return param.name;
}

/** On: a switch at its top value, a choice not named "Off". */
export function isOn(param: RackParam): boolean {
  const option = param.options?.find((o) => o.value === param.value);
  if (option) return !OFF.test(option.text);
  return param.value >= param.max;
}

/** The value that switches a band on: a switch's top, a choice's first value that is not "Off". */
export function onValue(param: RackParam): number {
  const options = param.options ?? [];
  if (options.length === 2 && param.min === 0 && param.max === 1) return param.max;
  return options.find((o) => !OFF.test(o.text))?.value ?? param.max;
}

/** Main first, then the groups in the plugin's order; a group of one stays in Main. */
export function groupParams(params: RackParam[]): ParamGroup[] {
  const byKey = new Map<string, RackParam[]>();
  for (const param of params) {
    const key = keyOf(param);
    byKey.set(key, [...(byKey.get(key) ?? []), param]);
  }
  const main: RackParam[] = byKey.get(MAIN) ?? [];
  const bands = [...byKey].filter(([key, members]) => key !== MAIN && members.length > 1);
  // A numbered parameter alone (a "Split frequency 8" without its band) stays in Main.
  for (const [key, members] of byKey) {
    if (key !== MAIN && members.length === 1) main.push(...members);
  }
  const numbered = bands.map(([key]) => key).filter((key) => key.startsWith('#'));
  const nameBand = bandNamer(numbered.map((key) => key.slice(1)));
  const groups: ParamGroup[] = bands.map(([key, members]) => {
    const activator = activatorOf(members);
    const label = key.startsWith('#') ? nameBand(key.slice(1)) : key;
    return { key, label, params: members, activator, active: !activator || isOn(activator) };
  });
  return main.length ? [{ key: MAIN, label: 'Main', params: main, activator: null, active: true }, ...groups] : groups;
}
