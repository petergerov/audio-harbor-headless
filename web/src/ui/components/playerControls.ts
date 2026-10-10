import type { RepeatMode, TransportCommand } from '../../api/types';
import { haptic } from '../../core/device';
import type { PlaybackClock } from '../../services/playbackClock';
import type { PlaybackActions } from '../../services/playbackService';
import { showToast } from '../overlay';
import { PlayerMarkup, type PlayerBindings } from './playerBindings';

export interface PlayerControlDeps {
  playback: PlaybackActions;
  clock: PlaybackClock;
  bindings: PlayerBindings;
}

/** Off → queue → track → off, as on the Mac. */
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

/** Wires the transport buttons, scrubbers, volume sliders, shuffle and repeat inside `root` to playback. */
export function bindPlayerControls(root: ParentNode, deps: PlayerControlDeps): void {
  root.querySelectorAll<HTMLElement>('[data-cmd]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const command = button.dataset.cmd as TransportCommand;
      haptic(command === 'toggle' ? 'medium' : 'light');
      void deps.playback.transport(command).catch(report);
    });
  });

  root.querySelectorAll<HTMLInputElement>(PlayerMarkup.volume).forEach((slider) => {
    slider.addEventListener('input', () => {
      void deps.playback.setVolume(Number(slider.value)).catch(report);
    });
  });

  root.querySelectorAll<HTMLInputElement>(PlayerMarkup.seek).forEach((scrubber) => {
    scrubber.addEventListener('pointerdown', () => deps.clock.beginScrub());
    scrubber.addEventListener('input', () => deps.bindings.labelPosition(Number(scrubber.value)));
    const commit = () => {
      const seconds = Number(scrubber.value || 0);
      if (deps.clock.endScrub(seconds)) void deps.playback.seek(seconds).catch(report);
    };
    scrubber.addEventListener('pointerup', commit);
    scrubber.addEventListener('change', commit);
  });

  // The bindings keep both buttons' state current; a click asks for the next one.
  root.querySelectorAll<HTMLElement>(PlayerMarkup.shuffle).forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      haptic('light');
      void deps.playback.setShuffle(button.getAttribute('aria-pressed') !== 'true').catch(report);
    });
  });

  root.querySelectorAll<HTMLElement>(PlayerMarkup.repeat).forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      haptic('light');
      const mode = (button.dataset.repeat ?? 'off') as RepeatMode;
      void deps.playback.setRepeat(NEXT_REPEAT[mode] ?? 'off').catch(report);
    });
  });
}

function report(err: unknown): void {
  showToast(err instanceof Error ? err.message : 'Playback failed', { error: true });
}
