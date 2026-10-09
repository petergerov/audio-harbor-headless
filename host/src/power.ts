import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Keeps the host from idle sleep while a network player streams from it — local playback
 * holds the audio device awake, network playback holds nothing. macOS: `caffeinate`;
 * Linux: `systemd-inhibit` when there is one; elsewhere it does nothing.
 */
export class KeepAwake {
  private child: ChildProcess | null = null;

  constructor(private readonly reason: string) {}

  hold(on: boolean): void {
    if (on === (this.child !== null)) return;
    if (!on) {
      const child = this.child;
      this.child = null;
      if (process.platform === 'linux') child?.stdin?.end();
      else child?.kill();
      return;
    }
    let child: ChildProcess;
    try {
      if (process.platform === 'darwin') {
        // -w: ends with this process even if it crashes.
        child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      } else if (process.platform === 'linux') {
        // `cat` holds the lock until its stdin closes — on release, or when this process dies.
        child = spawn(
          'systemd-inhibit',
          ['--what=idle:sleep', '--who=Audio Harbor', `--why=${this.reason}`, '--mode=block', 'cat'],
          { stdio: ['pipe', 'ignore', 'ignore'] }
        );
      } else {
        return;
      }
    } catch {
      return;
    }
    child.on('error', () => {
      if (this.child === child) this.child = null;
    });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    this.child = child;
  }
}
