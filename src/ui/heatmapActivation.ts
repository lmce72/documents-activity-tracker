/** A scroll or drag must not select a process when the pointer is released. */
export function onHeatmapActivate(element: HTMLElement, activate: () => void): void {
  let origin: { x: number; y: number } | null = null;
  let moved = false;
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  element.addEventListener('pointerdown', event => { origin = { x: event.clientX, y: event.clientY }; moved = false; });
  element.addEventListener('pointermove', event => {
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 6) moved = true;
  });
  element.addEventListener('pointercancel', () => { moved = true; origin = null; });
  element.addEventListener('click', event => { if (!moved || event.detail === 0) activate(); });
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
  });
}
