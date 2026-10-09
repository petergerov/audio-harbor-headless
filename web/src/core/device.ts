const DESKTOP_MQ = '(min-width: 700px)';

/** Sidebar and bottom bar on wide screens; tab bar, mini player and sheets on phones. */
export function isDesktopUi(): boolean {
  return window.matchMedia(DESKTOP_MQ).matches;
}

/** A short vibration where the browser has one (Android); a no-op elsewhere. */
export function haptic(style: 'light' | 'medium' = 'light'): void {
  try {
    if (navigator.vibrate) navigator.vibrate(style === 'medium' ? 12 : 8);
  } catch {
    /* not allowed here */
  }
}
