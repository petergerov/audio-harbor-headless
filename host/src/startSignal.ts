import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HarborConfig } from './types.js';

const run = promisify(execFile);

/** BCM GPIO numbers on the 40-pin header → physical pin (GPIO0/1 are the HAT EEPROM, left out). */
export const HEADER_PINS: Record<number, number> = {
  2: 3, 3: 5, 4: 7, 5: 29, 6: 31, 7: 26, 8: 24, 9: 21, 10: 19, 11: 23, 12: 32, 13: 33, 14: 8,
  15: 10, 16: 36, 17: 11, 18: 12, 19: 35, 20: 38, 21: 40, 22: 15, 23: 16, 24: 18, 25: 22, 26: 37,
  27: 13,
};

export const DEFAULT_START_SIGNAL_PIN = 17;

export function isHeaderGpio(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value in HEADER_PINS;
}

export interface StartSignalStatus {
  /** A Raspberry Pi with pinctrl or gpioset: the switch can be offered. */
  supported: boolean;
  /** "Raspberry Pi 4 Model B Rev 1.4", or "". */
  board: string;
  enabled: boolean;
  /** BCM GPIO number. */
  gpio: number;
  /** Physical header pin of `gpio`. */
  pin: number;
  /** The pin is high now. */
  active: boolean;
  /** Why the pin could not be set, or why there is no switch. */
  error: string | null;
  /** GPIOs the remote may pick, with their header pins. */
  choices: Array<{ gpio: number; pin: number }>;
}

type Driver =
  | { kind: 'pinctrl'; bin: string }
  | { kind: 'gpioset2'; bin: string }
  | { kind: 'gpioset1'; bin: string; gpiofind: string | null };

function which(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(':').concat(['/usr/bin', '/usr/sbin', '/bin', '/sbin']);
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      /* next */
    }
  }
  return null;
}

function stderrOf(err: unknown, fallback: string): string {
  const stderr = String((err as { stderr?: string | Buffer }).stderr ?? '').trim();
  return stderr.split('\n').pop() || (err instanceof Error ? err.message : '') || fallback;
}

function readBoard(): string {
  try {
    return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}

/**
 * A signal on a GPIO of the Raspberry Pi while Harbor runs: high once the host is up, low when
 * it stops — to switch on an amplifier, a relay or an LED. Settings → About → Start Signal.
 *
 * Set through `pinctrl` (Raspberry Pi OS) or, without it, libgpiod's `gpioset`, which holds the
 * line while it runs. The service user needs the `gpio` group (the .deb adds it).
 */
export class StartSignal {
  private readonly board = process.platform === 'linux' ? readBoard() : '';
  private driver: Driver | null | undefined;
  /** gpioset holding the line high. */
  private holder: ChildProcess | null = null;
  /** The GPIO that is high now. */
  private activeGpio: number | null = null;
  private error: string | null = null;
  private started = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly getConfig: () => HarborConfig,
    private readonly persist: (next: HarborConfig) => void
  ) {}

  private get isPi(): boolean {
    return this.board.startsWith('Raspberry Pi');
  }

  private async findDriver(): Promise<Driver | null> {
    if (this.driver !== undefined) return this.driver;
    this.driver = null;
    if (!this.isPi) return null;
    const pinctrl = which('pinctrl');
    if (pinctrl) return (this.driver = { kind: 'pinctrl', bin: pinctrl });
    const gpioset = which('gpioset');
    if (gpioset) {
      let version = '';
      try {
        ({ stdout: version } = await run(gpioset, ['--version'], { timeout: 5000 }));
      } catch (err) {
        version = String((err as { stdout?: string }).stdout ?? '');
      }
      this.driver = /v1\./.test(version)
        ? { kind: 'gpioset1', bin: gpioset, gpiofind: which('gpiofind') }
        : { kind: 'gpioset2', bin: gpioset };
    }
    return this.driver;
  }

  async status(): Promise<StartSignalStatus> {
    const cfg = this.getConfig().gpio;
    const driver = await this.findDriver();
    let error = this.error;
    if (!this.isPi) error = 'Not a Raspberry Pi';
    else if (!driver) error = 'Neither pinctrl nor gpioset is installed (sudo apt install gpiod)';
    return {
      supported: Boolean(driver),
      board: this.board,
      enabled: cfg.start_signal,
      gpio: cfg.start_signal_gpio,
      pin: HEADER_PINS[cfg.start_signal_gpio] ?? 0,
      active: this.activeGpio !== null,
      error,
      choices: Object.entries(HEADER_PINS)
        .map(([gpio, pin]) => ({ gpio: Number(gpio), pin }))
        .sort((a, b) => a.gpio - b.gpio),
    };
  }

  /** The host is up: the pin goes high when the signal is on. */
  async start(): Promise<void> {
    this.started = true;
    await this.serial(() => this.apply());
  }

  /** On or off, and which GPIO; saved in config.toml and applied at once. */
  async set(change: { enabled?: boolean; gpio?: number }): Promise<StartSignalStatus> {
    const cfg = this.getConfig();
    const next = {
      start_signal: change.enabled ?? cfg.gpio.start_signal,
      start_signal_gpio: change.gpio ?? cfg.gpio.start_signal_gpio,
    };
    this.persist({ ...cfg, gpio: next });
    if (this.started) await this.serial(() => this.apply());
    return this.status();
  }

  /** Harbor stops: the pin goes low. Synchronous, so it also runs from an `exit` handler. */
  stopSync(): void {
    this.started = false;
    const gpio = this.activeGpio;
    if (gpio === null || !this.driver) return;
    this.activeGpio = null;
    try {
      this.setLowSync(this.driver, gpio);
    } catch {
      /* the process ends anyway */
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async apply(): Promise<void> {
    const { start_signal: enabled, start_signal_gpio: gpio } = this.getConfig().gpio;
    const want = this.started && enabled ? gpio : null;
    if (want === this.activeGpio) return;
    const driver = await this.findDriver();
    if (!driver) return;
    this.error = null;
    if (this.activeGpio !== null) {
      const old = this.activeGpio;
      this.activeGpio = null;
      try {
        await this.setLow(driver, old);
      } catch (err) {
        this.error = `GPIO${old} could not be set low: ${stderrOf(err, 'unknown error')}`;
      }
    }
    if (want === null) return;
    try {
      await this.setHigh(driver, want);
      this.activeGpio = want;
      console.log(`Start signal: GPIO${want} (pin ${HEADER_PINS[want]}) high`);
    } catch (err) {
      this.error = `GPIO${want} could not be set: ${stderrOf(err, 'unknown error')}`;
      console.warn(`Start signal: ${this.error}`);
    }
  }

  /** gpioset v1 names a line by chip and offset: `gpiofind GPIO17` → "gpiochip0 17". */
  private lineOf(driver: Extract<Driver, { kind: 'gpioset1' }>, gpio: number): [string, string] {
    if (driver.gpiofind) {
      try {
        const [chip, offset] = execFileSync(driver.gpiofind, [`GPIO${gpio}`], { timeout: 3000 })
          .toString()
          .trim()
          .split(/\s+/);
        if (chip && offset) return [chip, offset];
      } catch {
        /* the first chip */
      }
    }
    return ['gpiochip0', String(gpio)];
  }

  /** The gpioset arguments that drive `gpio` to `value` (and exit, for low). */
  private gpiosetArgs(driver: Exclude<Driver, { kind: 'pinctrl' }>, gpio: number, value: 0 | 1): string[] {
    if (driver.kind === 'gpioset2') return value ? [`GPIO${gpio}=${value}`] : ['-t0', `GPIO${gpio}=0`];
    const [chip, offset] = this.lineOf(driver, gpio);
    return value ? ['--mode=signal', chip, `${offset}=1`] : [chip, `${offset}=0`];
  }

  private async setHigh(driver: Driver, gpio: number): Promise<void> {
    if (driver.kind === 'pinctrl') {
      await run(driver.bin, ['set', String(gpio), 'op', 'dh'], { timeout: 5000 });
      return;
    }
    // gpioset keeps the line only while it runs.
    const args = this.gpiosetArgs(driver, gpio, 1);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(driver.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      const failed = () => {
        clearTimeout(ok);
        reject(Object.assign(new Error('gpioset ended'), { stderr }));
      };
      // Still running after a moment: it holds the line.
      const ok = setTimeout(() => {
        child.off('exit', failed);
        this.holder = child;
        child.once('exit', () => {
          if (this.holder !== child) return;
          this.holder = null;
          this.activeGpio = null;
          this.error = `gpioset stopped: ${stderr.trim() || 'the line was released'}`;
        });
        resolve();
      }, 400);
      child.once('error', (err) => {
        clearTimeout(ok);
        reject(err);
      });
      child.once('exit', failed);
    });
  }

  private async setLow(driver: Driver, gpio: number): Promise<void> {
    if (driver.kind === 'pinctrl') {
      await run(driver.bin, ['set', String(gpio), 'op', 'dl'], { timeout: 5000 });
      return;
    }
    const child = this.holder;
    this.releaseHolder();
    // The line is free once the holder has gone.
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 2000);
        child.once('exit', () => {
          clearTimeout(done);
          resolve();
        });
      });
    }
    await run(driver.bin, this.gpiosetArgs(driver, gpio, 0), { timeout: 5000 });
  }

  /** `setLow` that blocks: for the `exit` handler. */
  private setLowSync(driver: Driver, gpio: number): void {
    if (driver.kind === 'pinctrl') {
      execFileSync(driver.bin, ['set', String(gpio), 'op', 'dl'], { timeout: 3000, stdio: 'ignore' });
      return;
    }
    this.releaseHolder();
    const args = this.gpiosetArgs(driver, gpio, 0);
    // The killed holder may still have the line for a moment.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        execFileSync(driver.bin, args, { timeout: 3000, stdio: 'ignore' });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  }

  private releaseHolder(): void {
    const child = this.holder;
    this.holder = null;
    if (!child || child.exitCode !== null) return;
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
  }
}
