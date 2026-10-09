/** Text for element content. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Text for an attribute value, single-quoted ones included. */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll("'", '&#39;');
}

/** The element `selector` names inside `root`; throws when the markup lacks it. */
export function required<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}
