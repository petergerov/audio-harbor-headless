import { volumePercent } from '../../core/format';
import { PlayerMarkup } from './playerBindings';

/**
 * Deck-only chrome that is not part of the shared transport contract: collapsing the
 * volume drawer, and keeping its percent label in step while the user drags.
 */
export function bindDeckChrome(root: ParentNode): void {
  const drawer = root.querySelector<HTMLElement>('[data-vol-drawer]');
  const toggle = root.querySelector<HTMLButtonElement>('[data-vol-toggle]');
  if (toggle && drawer) {
    toggle.addEventListener('click', () => {
      const open = drawer.hasAttribute('hidden');
      drawer.toggleAttribute('hidden', !open);
      toggle.setAttribute('aria-pressed', String(open));
      toggle.classList.toggle('is-on', open);
    });
  }

  root.querySelectorAll<HTMLInputElement>(PlayerMarkup.volume).forEach((slider) => {
    slider.addEventListener('input', () => {
      root.querySelectorAll(PlayerMarkup.volumePct).forEach((el) => {
        el.textContent = volumePercent(Number(slider.value));
      });
    });
  });
}
