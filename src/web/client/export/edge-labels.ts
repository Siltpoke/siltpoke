// Edge-number badges (spec §7.2, amended 2026-09-29, second pass): every drawn
// edge carries its number in a small pill sitting on the curve. The pill is placed
// at the first spot along the curve (middle first, then outward) where it touches
// no box, band name, boundary name or other badge; if the curve has no such spot
// it goes where it overlaps least — an edge is never left unnumbered. Pure numbers;
// build-svg draws what this returns.
import { textWidth } from "./layout-text";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Pt = [number, number];

export const BADGE_PX = 9;
const BADGE_H = 13;
const PAD_X = 4;
const SPACING = 3; // px kept clear around every other badge
/** Middle first, then alternately outward in small steps: the badge reads as belonging to the
 * middle of its edge, and a short gap between two boxes is still found. */
const SPOTS: number[] = [0.5];
for (let k = 1; k <= 15; k++) SPOTS.push(0.5 - 0.03 * k, 0.5 + 0.03 * k); // 0.47, 0.53, … 0.05, 0.95

const overlapArea = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const NUDGES = [0, BADGE_H / 2, -BADGE_H / 2];

/** Unit normal of the curve at t. */
function normal([p0, c, p1]: [Pt, Pt, Pt], t: number): Pt {
  const dx = 2 * (1 - t) * (c[0] - p0[0]) + 2 * t * (p1[0] - c[0]);
  const dy = 2 * (1 - t) * (c[1] - p0[1]) + 2 * t * (p1[1] - c[1]);
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

const at = ([p0, c, p1]: [Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
};

function badgeBox(label: string, [cx, cy]: Pt): Rect {
  const w = Math.max(BADGE_H, textWidth(label, "mono", BADGE_PX) + PAD_X * 2);
  return { x: cx - w / 2, y: cy - BADGE_H / 2, w, h: BADGE_H };
}

/**
 * Where the badge for `label` goes on the quadratic `curve`. `clear` is false when
 * no spot was free and the least-overlapping one was used. The box is pushed onto
 * `placed`, so later badges keep off it.
 */
export function placeBadge(
  label: string,
  curve: [Pt, Pt, Pt],
  obstacles: readonly Rect[],
  placed: Rect[],
): { box: Rect; centre: Pt; baseline: number; clear: boolean } {
  let best: { box: Rect; centre: Pt; cost: number } | null = null;
  // On the line first; only when no spot on it is free, nudge it to either side by up to half
  // its height, so it still touches its own edge.
  const candidates = NUDGES.flatMap((d) => SPOTS.map((t) => ({ t, d })));
  for (const { t, d } of candidates) {
    const [x, y] = at(curve, t);
    const [nx, ny] = normal(curve, t);
    const centre: Pt = [x + nx * d, y + ny * d];
    const box = badgeBox(label, centre);
    // Another badge costs more than a box edge: two numbers on top of each other cannot be read.
    // Badges keep a gap between them (SPACING), not just a non-overlap: numbers that touch read as one.
    const roomy = { x: box.x - SPACING, y: box.y - SPACING, w: box.w + 2 * SPACING, h: box.h + 2 * SPACING };
    const cost = obstacles.reduce((s, r) => s + overlapArea(box, r), 0) + placed.reduce((s, r) => s + 10 * overlapArea(roomy, r), 0);
    if (best === null || cost < best.cost) best = { box, centre, cost };
    if (cost === 0) break;
  }
  const chosen = best as { box: Rect; centre: Pt; cost: number };
  placed.push(chosen.box);
  return { box: chosen.box, centre: chosen.centre, baseline: chosen.centre[1] + BADGE_PX * 0.35, clear: chosen.cost === 0 };
}
