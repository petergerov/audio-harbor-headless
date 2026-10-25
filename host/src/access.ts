import type { HarborConfig } from './types.js';
import { isAuthorized, isFirstRun, keepOnly, openAccessToken, rotatePin } from './pairing.js';

/**
 * Who may use the host. By default anyone on the local network — no code to type
 * (`remote.require_pairing = false`). With the code on, only paired devices, as before.
 */
export class AccessPolicy {
  constructor(
    private readonly getConfig: () => HarborConfig,
    private readonly persist: (cfg: HarborConfig) => void
  ) {}

  get pairingRequired(): boolean {
    return this.getConfig().remote.require_pairing;
  }

  /** A request or connection with this token (or none) may go on. */
  allows(token: string | null | undefined): boolean {
    return !this.pairingRequired || isAuthorized(token);
  }

  /**
   * An install from before the code was optional, with devices paired, keeps asking for the
   * code — an update must not open it up. A new install starts without one.
   */
  adoptExistingInstall(): void {
    const cfg = this.getConfig();
    cfg.remote.require_pairing = !isFirstRun();
    // Written either way: the choice is made once, not again at every start.
    this.persist(cfg);
  }

  /**
   * The token a client gets without a code (the iOS app wants one to remember). One token for
   * all of them; it stops working once the code is switched on.
   */
  openToken(): string {
    return openAccessToken();
  }

  /**
   * Code on or off. Switching it on keeps the device that does it (it gets a token, returned)
   * and signs every other device out: they pair with the code again. A new PIN is made.
   */
  setPairingRequired(required: boolean, callerToken: string | null): string | null {
    const cfg = this.getConfig();
    if (cfg.remote.require_pairing === required) return required ? callerToken : null;
    cfg.remote.require_pairing = required;
    this.persist(cfg);
    if (!required) return null;
    const kept = keepOnly(callerToken);
    rotatePin();
    return kept;
  }
}
