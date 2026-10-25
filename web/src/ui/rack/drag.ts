/** What a drag on an element does: where it starts, each move, and (optionally) its end. */
export interface DragHandlers {
  start?(e: PointerEvent): void;
  move(e: PointerEvent): void;
  end?(e: PointerEvent): void;
}

/**
 * Pointer drags on `el` for knobs, faders and EQ points. The pointer is captured where the
 * browser allows it, but the drag is tracked here, so it holds however the browser behaves.
 */
export function onDrag(el: Element, handlers: DragHandlers): void {
  let pointer: number | null = null;
  el.addEventListener('pointerdown', (event) => {
    const e = event as PointerEvent;
    pointer = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // No capture (synthetic or already released pointer): the drag still works on `el`.
    }
    handlers.start?.(e);
  });
  el.addEventListener('pointermove', (event) => {
    const e = event as PointerEvent;
    if (pointer === e.pointerId) handlers.move(e);
  });
  const finish = (event: Event) => {
    const e = event as PointerEvent;
    if (pointer !== e.pointerId) return;
    pointer = null;
    handlers.end?.(e);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}
