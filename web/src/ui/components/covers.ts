import type { ArtworkApi } from '../../api/artworkApi';
import { initial } from '../../core/format';
import { escapeAttr, escapeHtml } from '../../core/html';

/** Album covers: image markup, and the fallbacks when an image cannot load. */
export class Covers {
  /** Roots whose covers already have the error listener. */
  private readonly hydrated = new WeakSet<ParentNode>();

  constructor(private readonly artwork: ArtworkApi) {}

  /** `<img>` markup for a cover, or null when there is no artwork. */
  img(hash: string | null | undefined, lazy = true): string | null {
    const url = this.artwork.url(hash);
    if (!url) return null;
    const loading = lazy ? ' loading="lazy" decoding="async"' : '';
    return `<img class="cover-img" src="${escapeAttr(url)}" alt=""${loading} data-cover="${escapeAttr(String(hash))}" />`;
  }

  /** The cover, or the title's initial when there is none. */
  html(hash: string | null | undefined, title: string): string {
    return this.img(hash) ?? `<span class="cover-fallback">${escapeHtml(initial(title))}</span>`;
  }

  /** Puts the cover into `slot`, keeping its placeholder when there is none. */
  fill(slot: Element | null, hash: string | null | undefined): void {
    const img = slot && this.img(hash, false);
    if (!slot || !img) return;
    slot.innerHTML = img;
    this.hydrate(slot);
  }

  /**
   * A cover that fails with the query token is fetched once more with the Authorization
   * header; when that fails too, the initial replaces it. One capturing listener per root (image
   * errors do not bubble), however many covers it holds.
   */
  hydrate(root: ParentNode): void {
    if (this.hydrated.has(root)) return;
    this.hydrated.add(root);
    root.addEventListener(
      'error',
      (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover-img')) return;
        const hash = img.dataset.cover;
        // The second try failed too, or there is nothing to try: the initial.
        if (img.dataset.retried || !hash) {
          img.replaceWith(fallback(img.alt));
          return;
        }
        img.dataset.retried = '1';
        this.artwork.objectUrl(hash).then(
          (url) => {
            img.src = url;
          },
          () => img.replaceWith(fallback(img.alt))
        );
      },
      true
    );
  }
}

function fallback(title: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cover-fallback';
  span.textContent = initial(title || '•');
  return span;
}
