// Where the exported HTML's side panel goes: level with the box that
// was clicked, but always wholly inside the window. Pure numbers, in viewport pixels.

const MARGIN = 12;

/**
 * `boxTop` is the clicked box's top on screen, `panelH` the panel's natural height, `viewH` the
 * window's height. The panel starts level with the box, moved up just enough to end inside the
 * window; a panel taller than the window starts at the top and scrolls inside (`maxHeight`).
 */
export function placePanel(boxTop: number, panelH: number, viewH: number): { top: number; maxHeight: number | null } {
  const room = viewH - 2 * MARGIN;
  if (panelH > room) return { top: MARGIN, maxHeight: Math.max(0, room) };
  return { top: Math.min(Math.max(boxTop, MARGIN), viewH - MARGIN - panelH), maxHeight: null };
}
