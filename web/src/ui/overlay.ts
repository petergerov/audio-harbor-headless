/** Responsive overlays: bottom sheet on mobile, centered modal on desktop. */

export type MenuItem = {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
};

const DESKTOP_MQ = '(min-width: 700px)';

let lastFocus: HTMLElement | null = null;

export function isDesktopUi(): boolean {
  return window.matchMedia(DESKTOP_MQ).matches;
}

export function closeOverlay(): void {
  const el = document.getElementById('ah-overlay');
  if (!el) return;
  // Drop the id right away so a follow-up overlay can mount while this one animates out.
  el.removeAttribute('id');
  const panel = el.querySelector<HTMLElement>('.ah-panel');
  if (panel) panel.style.transform = '';
  el.classList.add('closing');
  window.setTimeout(() => el.remove(), 220);
  document.body.classList.remove('overlay-open');
  if (lastFocus) {
    lastFocus.focus();
    lastFocus = null;
  }
}

function lockScroll(): void {
  document.body.classList.add('overlay-open');
}

function trapFocus(root: HTMLElement): void {
  const focusable = () =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((n) => n.offsetParent !== null || n === document.activeElement);

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeOverlay();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusable();
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

function mountShell(ariaLabel: string): { backdrop: HTMLElement; panel: HTMLElement } {
  closeOverlay();
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  lockScroll();
  const backdrop = document.createElement('div');
  backdrop.id = 'ah-overlay';
  backdrop.className = isDesktopUi() ? 'ah-overlay desktop' : 'ah-overlay mobile';
  backdrop.innerHTML = `
    <div class="ah-panel" role="dialog" aria-modal="true" aria-label="">
      <div class="ah-grabber" aria-hidden="true"></div>
      <div class="ah-panel-inner"></div>
    </div>
  `;
  const panel = backdrop.querySelector('.ah-panel') as HTMLElement;
  const inner = backdrop.querySelector('.ah-panel-inner') as HTMLElement;
  panel.setAttribute('aria-label', ariaLabel);
  panel.tabIndex = -1;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeOverlay();
  });
  document.body.appendChild(backdrop);
  trapFocus(panel);
  if (!isDesktopUi()) enableSwipeDismiss(panel, inner);
  queueMicrotask(() => {
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  });
  return { backdrop, panel: inner };
}

function enableSwipeDismiss(panel: HTMLElement, scroller: HTMLElement): void {
  let startY = 0;
  let dy = 0;
  let dragging = false;
  panel.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || scroller.scrollTop > 0) return;
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      startY = e.touches[0]!.clientY;
      dy = 0;
      dragging = true;
    },
    { passive: true }
  );
  panel.addEventListener(
    'touchmove',
    (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.touches[0]!.clientY - startY);
      panel.style.transition = 'none';
      panel.style.transform = dy ? `translateY(${dy}px)` : '';
    },
    { passive: true }
  );
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    if (dy > 90) closeOverlay();
    else panel.style.transform = '';
  };
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);
}

function reportError(err: unknown): void {
  showToast(err instanceof Error ? err.message : 'Something went wrong', { error: true });
}

export function openActionMenu(opts: {
  title: string;
  subtitle?: string;
  groups: MenuItem[][];
}): void {
  const { panel } = mountShell(opts.title);
  const groups = opts.groups
    .filter((g) => g.length)
    .map(
      (group, gi) => `
      <div class="ah-group">
        ${group
          .map(
            (item, ai) => `
          <button type="button" class="ah-row ${item.danger ? 'danger' : ''}"
            data-g="${gi}" data-a="${ai}" ${item.disabled ? 'disabled' : ''}>
            ${escapeHtml(item.label)}
          </button>`
          )
          .join('')}
      </div>`
    )
    .join('');

  panel.innerHTML = `
    <header class="ah-head">
      <p class="ah-kicker">${escapeHtml(opts.title)}</p>
      ${opts.subtitle ? `<p class="ah-sub">${escapeHtml(opts.subtitle)}</p>` : ''}
    </header>
    ${groups}
    <button type="button" class="ah-cancel">Cancel</button>
  `;

  const flat = opts.groups.filter((g) => g.length);
  panel.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = flat[Number(btn.dataset.g)]?.[Number(btn.dataset.a)];
      if (!item || item.disabled) return;
      closeOverlay();
      try {
        await item.run();
      } catch (err) {
        reportError(err);
      }
    });
  });
  panel.querySelector('.ah-cancel')?.addEventListener('click', () => closeOverlay());
  queueMicrotask(() => panel.querySelector<HTMLElement>('.ah-row')?.focus());
}

export function openPanel(opts: {
  title: string;
  subtitle?: string;
  bodyHtml: string;
  primaryLabel?: string;
  onPrimary?: () => void | Promise<void>;
  bind?: (root: HTMLElement, close: () => void) => void;
}): void {
  const { panel } = mountShell(opts.title);
  panel.innerHTML = `
    <header class="ah-head bar">
      <button type="button" class="ah-text-btn" data-close>Cancel</button>
      <div class="ah-head-titles">
        <p class="ah-kicker">${escapeHtml(opts.title)}</p>
        ${opts.subtitle ? `<p class="ah-sub">${escapeHtml(opts.subtitle)}</p>` : ''}
      </div>
      ${
        opts.primaryLabel
          ? `<button type="button" class="ah-text-btn accent" data-primary>${escapeHtml(opts.primaryLabel)}</button>`
          : `<span class="ah-text-btn spacer"></span>`
      }
    </header>
    <div class="ah-body">${opts.bodyHtml}</div>
  `;
  panel.querySelector('[data-close]')?.addEventListener('click', () => closeOverlay());
  panel.querySelector('[data-primary]')?.addEventListener('click', async () => {
    try {
      if (opts.onPrimary) await opts.onPrimary();
    } catch (err) {
      reportError(err);
    }
  });
  opts.bind?.(panel, closeOverlay);
}

export function openNameDialog(opts: {
  title: string;
  placeholder?: string;
  initial?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void | Promise<void>;
}): void {
  let input: HTMLInputElement | null = null;
  let busy = false;
  const submit = async () => {
    const value = input?.value.trim() ?? '';
    if (!value) {
      input?.focus();
      return;
    }
    if (busy) return;
    busy = true;
    try {
      await opts.onConfirm(value);
      closeOverlay();
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  };
  openPanel({
    title: opts.title,
    primaryLabel: opts.confirmLabel,
    bodyHtml: `
      <form class="ah-form" id="ahNameForm">
        <input class="ah-input" id="ahNameInput" type="text" enterkeyhint="done"
          placeholder="${escapeHtml(opts.placeholder ?? 'Name')}"
          aria-label="${escapeHtml(opts.placeholder ?? 'Name')}"
          value="${escapeHtml(opts.initial ?? '')}" autocomplete="off" />
      </form>
    `,
    onPrimary: submit,
    bind: (root) => {
      input = root.querySelector<HTMLInputElement>('#ahNameInput')!;
      root.querySelector('#ahNameForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        void submit();
      });
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });
    },
  });
}

export function openConfirmDialog(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}): void {
  openActionMenu({
    title: opts.title,
    subtitle: opts.message,
    groups: [
      [
        {
          label: opts.confirmLabel,
          danger: true,
          run: () => opts.onConfirm(),
        },
      ],
    ],
  });
}

export function showToast(
  message: string,
  opts?: { error?: boolean; undo?: () => void | Promise<void> }
): void {
  document.getElementById('ah-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'ah-toast';
  el.className = `ah-toast${opts?.error ? ' error' : ''}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = opts?.undo
    ? `<span>${escapeHtml(message)}</span><button type="button" class="ah-toast-undo">Undo</button>`
    : `<span>${escapeHtml(message)}</span>`;
  document.body.appendChild(el);
  const undoBtn = el.querySelector('.ah-toast-undo');
  undoBtn?.addEventListener('click', async () => {
    el.remove();
    await opts?.undo?.();
  });
  requestAnimationFrame(() => el.classList.add('show'));
  window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 280);
  }, opts?.undo ? 5000 : 2600);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
