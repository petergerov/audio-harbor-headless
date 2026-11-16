import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { RecordedFile, RecordFinalizeResult, RecordStatus } from '@harbor/engine';
import { normalizeRecording, RECORDING_RATES } from '../config.js';
import {
  engineCanRecord,
  engineRecordFinalize,
  engineRecordFinalizeProgress,
  engineRecordInputAccess,
  engineRecordInputs,
  engineRecordStart,
  engineRecordStatus,
  engineRecordStop,
} from '../engine/bridge.js';
import type { HarborConfig, RecordingConfig } from '../types.js';

/** Raw takes wait here (hidden: the library scan skips dot folders). */
const TAKES_DIR = '.takes';
/** No take starts with less free space; a running one stops below the second. */
const MIN_FREE_TO_START = 2 * 1024 ** 3;
const MIN_FREE_RUNNING = 512 * 1024 ** 2;

export class RecordingError extends Error {}

export type RecordingState = 'idle' | 'recording' | 'finalizing';

export interface RecordingInput {
  id: string;
  name: string;
}

/** A finished take, as the remote shows it. */
export interface RecordingTake {
  name: string;
  dir: string;
  files: Array<Omit<RecordedFile, 'path'> & { name: string }>;
  seconds: number;
  overruns: number;
  dropped: number;
  /** No samples lost on the way in. */
  bitPerfect: boolean;
  error: string | null;
}

export interface RecordingSnapshot {
  /** This engine can record on this platform (Linux / ALSA, macOS / Core Audio). */
  available: boolean;
  /** macOS privacy: may the host read inputs ("granted" elsewhere). */
  inputAccess: 'granted' | 'undetermined' | 'denied';
  settings: RecordingConfig;
  /** The folder takes go to, resolved. */
  folder: string;
  rates: readonly number[];
  state: RecordingState;
  /** The running take, live (peaks since the last snapshot). */
  live: RecordStatus | null;
  take: { name: string; startedAt: number; device: string; rate: number } | null;
  /** 0…1 while the take is being written into its files. */
  progress: number | null;
  last: RecordingTake | null;
  freeBytes: number | null;
}

export interface StartRequest {
  device?: string;
  rate?: number;
  split?: 'none' | 'silence';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-11-16 20-15-03" — sorts by time, valid on every file system. */
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function rateLabel(hz: number): string {
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** What the take turned out to be: "44.1k-16", "96k-24", "DSD64", "44.1k-16 + DSD64", … */
function formatLabel(files: RecordedFile[]): string {
  const labels: string[] = [];
  for (const f of files) {
    let label: string;
    if (f.kind === 'dsf') label = `DSD${Math.round(f.sampleRate / 44100)}`;
    else if (f.kind === 'spdif') label = 'bitstream';
    else label = `${rateLabel(f.sampleRate)}-${f.bits}`;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(' + ');
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fs.promises.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * Records the digital input bit-perfect: the engine captures to a raw 32-bit WAV, then writes
 * what the source sent — FLAC at the bit depth really used, DSF for DoP, raw IEC 61937 for
 * Dolby / DTS — into a folder named after the time and format, and the library picks it up.
 */
export class RecordingService extends EventEmitter {
  private state: RecordingState = 'idle';
  private take: {
    name: string;
    startedAt: number;
    device: string;
    rate: number;
    rawPath: string;
    split: boolean;
    folder: string;
  } | null = null;
  private last: RecordingTake | null = null;
  private watch: NodeJS.Timeout | null = null;
  private free: number | null = null;

  constructor(
    private readonly getConfig: () => HarborConfig,
    private readonly persist: (cfg: HarborConfig) => void,
    /** The library looks at new files (rescan of its folders). */
    private readonly rescan: () => Promise<unknown>
  ) {
    super();
  }

  /** Where takes go. */
  folder(): string {
    const cfg = this.getConfig();
    if (cfg.recording.folder) return path.resolve(expandHome(cfg.recording.folder));
    const root = cfg.library.roots[0];
    return root ? path.join(root, 'Recordings') : path.join(os.homedir(), 'Music', 'Recordings');
  }

  available(): boolean {
    const platform = process.platform === 'linux' || process.platform === 'darwin';
    return engineCanRecord() && (platform || Boolean(process.env.HARBOR_RECORD_TEST_INPUT));
  }

  inputs(): RecordingInput[] {
    const list = engineRecordInputs().map((i) => ({ id: i.id, name: i.name }));
    // A WAV fed in as if live, for trying the remote without the HAT.
    const test = process.env.HARBOR_RECORD_TEST_INPUT;
    if (test) list.push({ id: `file:${test}`, name: `Test input (${path.basename(test)})` });
    return list;
  }

  async snapshot(): Promise<RecordingSnapshot> {
    const folder = this.folder();
    if (this.state !== 'recording' || this.free === null) {
      this.free = await freeBytes(fs.existsSync(folder) ? folder : path.dirname(folder));
    }
    return {
      available: this.available(),
      inputAccess: engineRecordInputAccess(),
      settings: this.getConfig().recording,
      folder,
      rates: RECORDING_RATES,
      state: this.state,
      live: this.state === 'recording' ? engineRecordStatus() : null,
      take: this.take
        ? { name: this.take.name, startedAt: this.take.startedAt, device: this.take.device, rate: this.take.rate }
        : null,
      progress: this.state === 'finalizing' ? engineRecordFinalizeProgress() : null,
      last: this.last,
      freeBytes: this.free,
    };
  }

  /** Changes to the recording settings (not while a take runs). */
  async updateSettings(patch: Partial<RecordingConfig>): Promise<RecordingConfig> {
    const cfg = this.getConfig();
    const next = normalizeRecording({ ...cfg.recording, ...patch }, cfg.recording);
    if (next.folder && next.folder !== cfg.recording.folder) {
      // A folder takes can be written to, made if it is not there yet.
      const dir = path.resolve(expandHome(next.folder));
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.access(dir, fs.constants.W_OK);
      } catch {
        throw new RecordingError(`Cannot write to ${dir}`);
      }
      next.folder = dir;
    }
    if (
      this.state !== 'idle' &&
      (next.device !== cfg.recording.device || next.rate !== cfg.recording.rate || next.folder !== cfg.recording.folder)
    ) {
      throw new RecordingError('Not while recording');
    }
    this.persist({ ...cfg, recording: next });
    this.emit('change');
    return next;
  }

  async start(req: StartRequest = {}): Promise<RecordingSnapshot> {
    if (this.state !== 'idle') throw new RecordingError('A take is already running');
    const settings = this.getConfig().recording;
    if (!settings.enabled) throw new RecordingError('Recording is off (Settings → Recording)');
    if (!engineCanRecord()) throw new RecordingError('This engine cannot record');
    const device = req.device?.trim() || settings.device || this.inputs()[0]?.id;
    if (!device) {
      throw new RecordingError(
        process.platform === 'darwin'
          ? 'No stereo audio input found — connect the audio interface'
          : 'No input found — is the S/PDIF HAT set up (dtoverlay=hifiberry-digi)?'
      );
    }
    const rate = req.rate ?? settings.rate;
    if (!(RECORDING_RATES as readonly number[]).includes(rate)) throw new RecordingError(`Unsupported rate ${rate}`);

    const folder = this.folder();
    const takes = path.join(folder, TAKES_DIR);
    try {
      await fs.promises.mkdir(takes, { recursive: true });
    } catch (err) {
      throw new RecordingError(`Cannot create ${takes}: ${(err as Error).message}`);
    }
    const free = await freeBytes(folder);
    if (free !== null && free < MIN_FREE_TO_START) {
      throw new RecordingError(`Only ${(free / 1024 ** 3).toFixed(1)} GB free in ${folder}`);
    }
    const name = stamp(new Date());
    const rawPath = path.join(takes, `${name}.raw.wav`);
    try {
      engineRecordStart({ device, rate, channels: 2, rawPath, silenceDb: settings.silence_db });
    } catch (err) {
      throw new RecordingError((err as Error).message);
    }
    this.state = 'recording';
    this.free = free;
    this.take = {
      name,
      startedAt: Date.now(),
      device,
      rate,
      rawPath,
      split: (req.split ?? settings.split) === 'silence',
      folder,
    };
    this.watch = setInterval(() => void this.check(), 2000);
    this.emit('change');
    return this.snapshot();
  }

  /** Stops the take; `discard` throws it away, otherwise it is written into its files. */
  async stop(discard = false): Promise<RecordingSnapshot> {
    if (this.state !== 'recording' || !this.take) throw new RecordingError('No take is running');
    const take = this.take;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    const status = engineRecordStop();
    if (discard) {
      await fs.promises.rm(take.rawPath, { force: true });
      this.state = 'idle';
      this.take = null;
      this.emit('change');
      return this.snapshot();
    }
    this.state = 'finalizing';
    this.emit('change');
    void this.finalize(take.folder, take.rawPath, take.name, take.split, status).finally(() => {
      this.state = 'idle';
      this.take = null;
      this.emit('change');
    });
    return this.snapshot();
  }

  /** Takes a crash or power cut left behind are written into their files at start. */
  async recover(): Promise<void> {
    if (!engineCanRecord()) return;
    const takes = path.join(this.folder(), TAKES_DIR);
    let names: string[];
    try {
      names = await fs.promises.readdir(takes);
    } catch {
      return;
    }
    const done = new Set(await fs.promises.readdir(this.folder()).catch(() => [] as string[]));
    for (const file of names.filter((n) => n.endsWith('.raw.wav')).sort()) {
      const name = file.slice(0, -'.raw.wav'.length);
      // Finished, raw kept on purpose (keep_raw): its folder carries the format label. A folder
      // with the bare name was cut off while being written and is written again.
      if ([...done].some((d) => d.startsWith(`${name} (`))) continue;
      if (this.state !== 'idle') return;
      console.log(`Recording: finishing the take ${name} left from before`);
      this.state = 'finalizing';
      this.emit('change');
      try {
        await this.finalize(this.folder(), path.join(takes, file), name, this.getConfig().recording.split === 'silence', null);
      } finally {
        this.state = 'idle';
        this.emit('change');
      }
    }
  }

  /** While recording: the take stopped by itself (disk, device), or the disk is nearly full. */
  private async check(): Promise<void> {
    if (this.state !== 'recording') return;
    const st = engineRecordStatus();
    this.free = await freeBytes(this.take?.folder ?? this.folder());
    const full = this.free !== null && this.free < MIN_FREE_RUNNING;
    if (st?.failed || full) {
      console.warn(`Recording stopped: ${st?.error ?? 'disk nearly full'}`);
      await this.stop().catch(() => undefined);
    }
  }

  private async finalize(
    folder: string,
    rawPath: string,
    name: string,
    split: boolean,
    status: RecordStatus | null
  ): Promise<void> {
    const settings = this.getConfig().recording;
    const outDir = path.join(folder, name);
    const date = name.slice(0, 10);
    const tags: Record<string, string> = {
      ALBUM: `Recording ${date} ${name.slice(11).replace(/-/g, ':')}`,
      ARTIST: 'S/PDIF In',
      DATE: date,
      COMMENT: 'Recorded bit-perfect by Audio Harbor',
    };
    if (status && (status.overruns || status.dropped)) {
      tags.COMMENT = `Recorded by Audio Harbor; ${status.overruns} overruns, ${status.dropped} frames lost`;
    }
    let result: RecordFinalizeResult | null = null;
    let error: string | null = null;
    try {
      await fs.promises.mkdir(outDir, { recursive: true });
      result = await engineRecordFinalize({
        rawPath,
        outDir,
        split,
        silenceDb: settings.silence_db,
        silenceSeconds: settings.silence_seconds,
        tags,
        titleBase: 'Track',
      });
    } catch (err) {
      error = (err as Error).message;
    }

    let dir = outDir;
    if (result && result.files.length) {
      // The folder says what came in: "2026-11-16 20-15-03 (96k-24)".
      const labelled = path.join(folder, `${name} (${formatLabel(result.files)})`);
      try {
        await fs.promises.rename(outDir, labelled);
        dir = labelled;
      } catch {
        // keep the plain name
      }
    } else if (result) {
      await fs.promises.rmdir(outDir).catch(() => undefined);
      error = error ?? 'Nothing came in (no signal or only silence)';
    }
    if (result && !error && !settings.keep_raw) await fs.promises.rm(rawPath, { force: true });

    const overruns = status?.overruns ?? 0;
    const dropped = status?.dropped ?? 0;
    this.last = {
      name: path.basename(dir),
      dir,
      files: (result?.files ?? []).map(({ path: p, ...rest }) => ({ ...rest, name: path.basename(p) })),
      seconds: result && status?.rate ? result.totalFrames / status.rate : (result?.files ?? []).reduce((s, f) => s + f.seconds, 0),
      overruns,
      dropped,
      bitPerfect: overruns === 0 && dropped === 0,
      error,
    };
    if (error) console.warn(`Recording ${name}: ${error}${result ? '' : ` (raw take kept: ${rawPath})`}`);
    else console.log(`Recording ${name}: ${result?.files.length ?? 0} file(s) in ${dir}`);
    if (result?.files.length) void this.rescan().catch(() => undefined);
  }

  /** On shutdown: stop capturing; the raw take is finished at the next start. */
  shutdown(): void {
    if (this.state === 'recording') {
      if (this.watch) clearInterval(this.watch);
      engineRecordStop();
    }
  }
}
