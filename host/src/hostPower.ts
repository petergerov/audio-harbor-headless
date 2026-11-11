import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Root helper from the Linux package; the service may run it through sudo (group harbor-drives). */
const HELPER = '/usr/libexec/audio-harbor-headless/harbor-power';

export type PowerAction = 'poweroff' | 'reboot';

/**
 * The power button on GPIO3 (Raspberry Pi 3/4/Zero 2):
 * off / on — in config.txt from here; builtin — a Pi 5 has its own; external — set in config.txt
 * by hand; blocked — GPIO3 is used for I2C (a DAC HAT); unsupported — no Raspberry Pi.
 */
export type PowerButtonState = 'off' | 'on' | 'builtin' | 'external' | 'blocked' | 'unsupported';

export interface PowerStatus {
  /** Shut down and restart work from the remote: the .deb, run as the audioharbor@ service. */
  canPowerOff: boolean;
  /** Why not, on Linux; null elsewhere. */
  note: string | null;
  /** Null where there is no helper to ask (a Mac, a manual start). */
  button: {
    state: PowerButtonState;
    /** "Raspberry Pi 4 Model B Rev 1.4", or "". */
    board: string;
    /** Changed since boot: works after the next restart. */
    restartPending: boolean;
    note: string | null;
  } | null;
}

export class PowerError extends Error {}

const BUTTON_STATES: PowerButtonState[] = ['off', 'on', 'builtin', 'external', 'blocked', 'unsupported'];

function stderrOf(err: unknown, fallback: string): string {
  const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
  return stderr.split('\n').pop() || fallback;
}

/** Shut down and restart the host, and the Pi's power button — through the root helper. */
export class HostPower {
  private allowed: boolean | null = null;

  private async helperAllowed(): Promise<boolean> {
    if (this.allowed) return true;
    if (process.platform !== 'linux' || !fs.existsSync(HELPER)) return false;
    try {
      await run('sudo', ['-n', '-l', HELPER], { timeout: 5000 });
      this.allowed = true;
    } catch {
      this.allowed = false;
    }
    return this.allowed;
  }

  async status(): Promise<PowerStatus> {
    if (!(await this.helperAllowed())) {
      return {
        canPowerOff: false,
        // Elsewhere (a Mac) the remote leaves Power out.
        note:
          process.platform === 'linux'
            ? 'Shut Down and Restart work when Harbor runs as the audioharbor@ service.'
            : null,
        button: null,
      };
    }
    return { canPowerOff: true, note: null, button: await this.button() };
  }

  /** In 2 s: the answer reaches the remote before the service stops. */
  async act(action: PowerAction): Promise<void> {
    if (action !== 'poweroff' && action !== 'reboot') throw new PowerError('Unknown action');
    if (!(await this.helperAllowed())) throw new PowerError('Not from here: Harbor does not run as the service');
    try {
      await run('sudo', ['-n', HELPER, action], { timeout: 15_000 });
    } catch (err) {
      throw new PowerError(stderrOf(err, `Could not ${action === 'reboot' ? 'restart' : 'shut down'}`));
    }
  }

  async setButton(on: boolean): Promise<PowerStatus> {
    if (!(await this.helperAllowed())) throw new PowerError('Not from here: Harbor does not run as the service');
    try {
      await run('sudo', ['-n', HELPER, 'button', on ? 'on' : 'off'], { timeout: 15_000 });
    } catch (err) {
      throw new PowerError(stderrOf(err, 'Could not change config.txt'));
    }
    return this.status();
  }

  private async button(): Promise<PowerStatus['button']> {
    let text: string;
    try {
      ({ stdout: text } = await run('sudo', ['-n', HELPER, 'button'], { timeout: 5000 }));
    } catch {
      return null;
    }
    const fields = new Map<string, string>();
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) fields.set(line.slice(0, i), line.slice(i + 1));
    }
    const state = BUTTON_STATES.find((s) => s === fields.get('state')) ?? 'unsupported';
    return {
      state,
      board: fields.get('board') ?? '',
      restartPending: fields.get('pending') === '1',
      note: fields.get('note') || null,
    };
  }
}
