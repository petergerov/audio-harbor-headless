import type { AuthApi } from '../../api/authApi';
import { ApiError, type TokenStore } from '../../api/http';
import { errorMessage } from '../../core/errors';
import { required } from '../../core/html';

/** First run on a device: trade the host's 6-digit PIN for a token. */
export class PairingView {
  constructor(
    private readonly auth: AuthApi,
    private readonly tokens: TokenStore,
    private readonly onPaired: () => void | Promise<void>
  ) {}

  render(root: HTMLElement): void {
    root.innerHTML = `
      <main class="pair-screen">
        <div class="pair-card">
          <div class="pair-mark">AH</div>
          <h1>Audio Harbor</h1>
          <p>Enter the 6-digit PIN from the host to pair this device.</p>
          <input id="pin" class="pin-input" inputmode="numeric" maxlength="6"
            placeholder="••••••" autocomplete="one-time-code" enterkeyhint="done" />
          <button data-pair class="btn-fill">Continue</button>
          <p data-error class="err" hidden></p>
        </div>
      </main>
    `;
    const pin = required<HTMLInputElement>(root, '#pin');
    const error = required(root, '[data-error]');
    const button = required<HTMLButtonElement>(root, '[data-pair]');
    pin.focus();
    const submit = async () => {
      error.hidden = true;
      button.disabled = true;
      try {
        this.tokens.set(await this.auth.pair(pin.value.trim()));
        await this.onPaired();
      } catch (err) {
        error.hidden = false;
        // 429: too many wrong PINs; the host says when to try again.
        error.textContent =
          err instanceof ApiError
            ? err.status === 429
              ? err.message
              : 'Incorrect PIN. Try again.'
            : errorMessage(err, 'Pairing failed');
        button.disabled = false;
      }
    };
    button.addEventListener('click', () => void submit());
    pin.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void submit();
    });
  }
}
