import { escapeAttr } from '../../../core/html';
import { icons } from '../../icons';
import { openPanel } from '../../overlay';

/** A note this long is an explanation: it moves behind the section's info button. */
const LONG_NOTE = 80;

/** Whether a footer note is a fixed explanation (not a status line the pane keeps updating, not a warning). */
function isExplanation(note: HTMLElement): boolean {
  // A pane marks an explanation it fills itself with data-explain (its text may come later).
  if (note.hasAttribute('data-explain')) return true;
  if (note.getAttributeNames().some((n) => n.startsWith('data-') && n !== 'data-info-done')) return false;
  if ((note.getAttribute('style') ?? '').includes('danger')) return false;
  return (note.textContent ?? '').trim().length >= LONG_NOTE;
}

/** The section a note explains: the nearest section label above it. */
function sectionLabel(note: HTMLElement): HTMLElement | null {
  let el = note.previousElementSibling;
  while (el) {
    if (el.classList.contains('group-label')) return el as HTMLElement;
    el = el.previousElementSibling;
  }
  return null;
}

/** The explanations below `label`, up to the next section. */
function notesOf(label: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let el = label.nextElementSibling;
  while (el && !el.classList.contains('group-label')) {
    if (el.classList.contains('note-in-info')) out.push(el as HTMLElement);
    el = el.nextElementSibling;
  }
  return out;
}

function labelText(label: HTMLElement): string {
  return Array.from(label.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? '')
    .join('')
    .trim();
}

/** Moves long explanations behind an info button at their section's label. Idempotent. */
function collapse(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>('p.footer-note:not([data-info-done])').forEach((note) => {
    note.setAttribute('data-info-done', '');
    if (!isExplanation(note)) return;
    const label = sectionLabel(note);
    if (!label) return;
    note.classList.add('note-in-info');
    if (label.querySelector('.info-btn')) return;
    const name = labelText(label);
    label.classList.add('has-info');
    label.insertAdjacentHTML(
      'beforeend',
      `<button type="button" class="info-btn" aria-label="${escapeAttr(`About ${name}`)}" title="About ${escapeAttr(name)}">${icons.info}</button>`
    );
  });
}

/**
 * Settings explain a lot; the long explanations sit behind an info button (ⓘ) at the right end of
 * their section's label, and a tap shows them. Short notes, warnings and live status lines stay
 * where they are. Follows the panes as they repaint. Returns a function that stops it.
 */
export function bindInfoNotes(body: HTMLElement): () => void {
  collapse(body);
  const observer = new MutationObserver(() => collapse(body));
  observer.observe(body, { childList: true, subtree: true });
  const onClick = (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('.info-btn');
    const label = button?.closest<HTMLElement>('.group-label');
    if (!button || !label || !body.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const notes = notesOf(label);
    if (!notes.length) return;
    openPanel({
      title: labelText(label) || 'About',
      bodyHtml: `<div class="info-sheet">${notes.map((n) => `<p>${n.innerHTML}</p>`).join('')}</div>`,
    });
  };
  body.addEventListener('click', onClick);
  return () => {
    observer.disconnect();
    body.removeEventListener('click', onClick);
  };
}
