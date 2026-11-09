/** Loads the host's current build of the remote: drops the offline shell's caches first. */
export async function reloadRemote(): Promise<void> {
  if ('caches' in window) {
    await caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .catch(() => undefined);
  }
  location.reload();
}

/** The script this page runs (`/assets/index-….js`); null in development. */
function runningScript(): string | null {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  return src ? new URL(src, location.href).pathname : null;
}

/**
 * Whether the host now serves another build than the one on screen (it was updated or rebuilt
 * while this page stayed open): its index.html links another script.
 */
export async function hostHasNewRemote(): Promise<boolean> {
  const running = runningScript();
  if (!running) return false;
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return false;
    const html = await res.text();
    const served = /<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    return Boolean(served && new URL(served, location.href).pathname !== running);
  } catch {
    return false;
  }
}
