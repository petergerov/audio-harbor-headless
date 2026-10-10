import { EventEmitter } from 'node:events';
import type { Catalogue } from '../library/catalogue.js';
import type { HarborConfig } from '../types.js';
import { startDlnaServer, type DlnaServer } from './mediaServer.js';

/**
 * The DLNA music server (`[sharing]`), started and stopped while the host runs. Emits `change`
 * when it starts, stops or fails, and when a stream starts or ends.
 */
export class Sharing extends EventEmitter {
  statusText = 'Off';
  private server: DlnaServer | null = null;
  /** Start and stop run one after another. */
  private work: Promise<void> = Promise.resolve();

  constructor(
    private readonly catalogue: Catalogue,
    private readonly getConfig: () => HarborConfig,
    private readonly saveConfig: (cfg: HarborConfig) => void
  ) {
    super();
  }

  get enabled(): boolean {
    return this.getConfig().sharing.enabled;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get activeStreams(): number {
    return this.server?.activeStreams ?? 0;
  }

  /** Starts the server when sharing is on in the config. */
  start(): Promise<void> {
    return this.serially(() => this.open());
  }

  /**
   * Stores the choice and starts or stops the server. Throws when turning on fails
   * (port taken, …) so the remote can keep the switch off.
   */
  setEnabled(on: boolean): Promise<void> {
    const cfg = this.getConfig();
    if (cfg.sharing.enabled !== on) {
      cfg.sharing.enabled = on;
      this.saveConfig(cfg);
    }
    return this.serially(async () => {
      if (on) await this.open();
      else await this.close();
      if (on && !this.server) {
        throw new Error(this.statusText.replace(/^Failed:\s*/, '') || 'Could not start sharing');
      }
    });
  }

  /** Starts again, e.g. with another port or name. */
  restart(): Promise<void> {
    return this.serially(async () => {
      await this.close();
      await this.open();
    });
  }

  private serially(step: () => Promise<void>): Promise<void> {
    this.work = this.work.then(step, step);
    return this.work;
  }

  private async open(): Promise<void> {
    if (this.server || !this.enabled) return;
    const { port, friendly_name: name } = this.getConfig().sharing;
    this.setStatus('Starting…');
    try {
      this.server = await startDlnaServer({
        port,
        friendlyName: name,
        catalogue: this.catalogue,
        roots: () => this.getConfig().library.roots,
        dsdLevel: () => this.getConfig().output.dsd_pcm_level,
        onStreams: () => this.emit('change'),
      });
      console.log(`DLNA music server on port ${port}`);
      this.setStatus(`Sharing as “${name}” on port ${port}`);
    } catch (err) {
      // Leave the switch off when the server could not start (e.g. port taken).
      const cfg = this.getConfig();
      if (cfg.sharing.enabled) {
        cfg.sharing.enabled = false;
        this.saveConfig(cfg);
      }
      this.setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await server.close();
    this.setStatus('Off');
  }

  private setStatus(text: string): void {
    this.statusText = text;
    this.emit('change');
  }
}
