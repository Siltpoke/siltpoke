// Pure geometry for the export SVG: content bounds and the edge curves. The
// curves follow the on-screen C4 view (drawArchC4 in islands/repo-graph.ts):
// edges that share an endpoint fan out along that box's side instead of
// meeting at one point, the tip stops a few px outside the target box, and the
// line bows slightly. Numbers only — nothing here emits markup.
import type { C4Model } from "../islands/repo-graph-c4-model";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Pt = [number, number];

const FAN_SPREAD = 18; // px between neighbouring anchors on one side (the page's value)
const ARROW_GAP = 6; // the tip sits this far outside the target border (the page's value)
const HEAD_LEN = 6; // arrowhead arm length along the line
const HEAD_HALF = 3.2; // arrowhead half-width

export function contentBounds(model: C4Model): { w: number; h: number } {
  const all: Rect[] = [...Object.values(model.N), ...model.BANDS];
  if (model.BOUNDARY.w > 0) all.push(model.BOUNDARY);
  return {
    w: all.reduce((m, r) => Math.max(m, r.x + r.w), 0),
    h: all.reduce((m, r) => Math.max(m, r.y + r.h), 0),
  };
}

const centre = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h / 2];

/** Where the line from `r`'s centre toward (tx, ty) leaves `r`'s border. */
function clip(r: Rect, tx: number, ty: number): Pt {
  const [cx, cy] = centre(r);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const k = Math.min(dx === 0 ? Infinity : r.w / 2 / Math.abs(dx), dy === 0 ? Infinity : r.h / 2 / Math.abs(dy));
  return [cx + dx * k, cy + dy * k];
}

/** Slide a border point along the side it sits on, by the edge's place among its siblings; clamped inside the side. */
function fan(border: Pt, r: Rect, idx: number, n: number, dx: number, dy: number): Pt {
  if (n <= 1) return border;
  const off = (idx - (n - 1) / 2) * FAN_SPREAD;
  const [cx, cy] = centre(r);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const m = Math.max(0, r.h / 2 - 8);
    return [border[0], cy + Math.max(-m, Math.min(m, off))];
  }
  const m = Math.max(0, r.w / 2 - 8);
  return [cx + Math.max(-m, Math.min(m, off)), border[1]];
}

interface EdgeGeom {
  /** Quadratic curve: start, control, end (the end is the arrow tip). */
  curve: [Pt, Pt, Pt];
  /** Open arrowhead: arm, tip, arm. */
  head: [Pt, Pt, Pt];
  /** The curve's own midpoint (t = 0.5), where a label is centred. */
  mid: Pt;
}

/** One geometry per edge of `model.E`, in order; null where an endpoint is missing. */
export function edgeGeoms(model: C4Model): Array<EdgeGeom | null> {
  const count = (i: 0 | 1): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of model.E) if (model.N[e[0]] && model.N[e[1]]) m.set(e[i], (m.get(e[i]) ?? 0) + 1);
    return m;
  };
  const srcN = count(0);
  const tgtN = count(1);
  const srcI = new Map<string, number>();
  const tgtI = new Map<string, number>();
  return model.E.map(([s, t]) => {
    const a = model.N[s];
    const z = model.N[t];
    if (!a || !z) return null;
    const si = srcI.get(s) ?? 0;
    srcI.set(s, si + 1);
    const ti = tgtI.get(t) ?? 0;
    tgtI.set(t, ti + 1);
    const ca = centre(a);
    const cz = centre(z);
    const dx = cz[0] - ca[0];
    const dy = cz[1] - ca[1];
    const p1 = fan(clip(a, cz[0], cz[1]), a, si, srcN.get(s) ?? 1, dx, dy);
    const b2 = fan(clip(z, ca[0], ca[1]), z, ti, tgtN.get(t) ?? 1, -dx, -dy);
    const ol = Math.hypot(b2[0] - cz[0], b2[1] - cz[1]) || 1;
    const p2: Pt = [b2[0] + ((b2[0] - cz[0]) / ol) * ARROW_GAP, b2[1] + ((b2[1] - cz[1]) / ol) * ARROW_GAP];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
    const bow = Math.min(len * 0.06, 16);
    const c: Pt = [(p1[0] + p2[0]) / 2 - ((p2[1] - p1[1]) / len) * bow, (p1[1] + p2[1]) / 2 + ((p2[0] - p1[0]) / len) * bow];
    // The tip points along the curve's end tangent (control → end).
    const tl = Math.hypot(p2[0] - c[0], p2[1] - c[1]) || 1;
    const ux = (p2[0] - c[0]) / tl;
    const uy = (p2[1] - c[1]) / tl;
    const bx = p2[0] - ux * HEAD_LEN;
    const by = p2[1] - uy * HEAD_LEN;
    return {
      curve: [p1, c, p2],
      head: [[bx - uy * HEAD_HALF, by + ux * HEAD_HALF], p2, [bx + uy * HEAD_HALF, by - ux * HEAD_HALF]],
      mid: [(p1[0] + 2 * c[0] + p2[0]) / 4, (p1[1] + 2 * c[1] + p2[1]) / 4],
    };
  });
}
