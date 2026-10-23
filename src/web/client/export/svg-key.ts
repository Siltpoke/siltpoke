// The edge key under the diagram (spec §7.2, amended 2026-09-29, second pass): one
// row per numbered edge — a short stroke drawn the way the edge is drawn (solid or
// dashed), its number, then `From → To — verb`, wrapped and never cut. Rows fill
// columns top to bottom, balanced by their real heights; the column count follows the export width. Every string comes from the model and
// goes through esc() (textBlock); the finished SVG is scanned like the rest.
import type { C4Model } from "../islands/repo-graph-c4-model";
import type { ListedEdge } from "./edge-list";
import { textWidth, wrapText } from "./layout-text";
import type { SvgPalette } from "./svg-style";
import { FAM, num, textBlock } from "./svg-text";

const KEY_ROW_H = 16;
const COL_MIN_W = 360;
const COL_GAP = 20;
const STROKE_W = 18;
const NUM_W = 30; // room for a 3-digit number clear of the stroke
const KEY_PX = 11;
const WRAP_LH = 14; // between the lines of one wrapped row

interface KeyStroke {
  attrs: string;
  dash: string;
}

/** The key's rows as text, in number order — `3  Daemon → Memory — reads`. */
function keyRowText(e: ListedEdge, model: C4Model): string {
  const name = (id: string): string => model.N[id]?.title ?? id;
  const verb = e.verb.trim();
  return `${name(e.source)} → ${name(e.target)}${verb ? ` — ${verb}` : ""}`;
}

/** Split the rows into at most `cols` columns, top to bottom, keeping the columns about
 * equally tall (a row that wraps counts for its real height). */
function columns(heights: number[], cols: number): number[][] {
  const total = heights.reduce((a, h) => a + h, 0);
  const target = total / cols;
  const out: number[][] = [[]];
  let used = 0;
  for (const [i, h] of heights.entries()) {
    if (used > 0 && used + h / 2 > target && out.length < cols) {
      out.push([]);
      used = 0;
    }
    out[out.length - 1].push(i);
    used += h;
  }
  return out;
}

export function renderKey(
  rows: ListedEdge[],
  model: C4Model,
  x0: number,
  y0: number,
  width: number,
  pal: SvgPalette,
  stroke: KeyStroke,
): { svg: string; height: number } {
  const drawn = rows.filter((r) => r.n !== undefined);
  if (!drawn.length) return { svg: "", height: 0 };
  const cols = Math.max(1, Math.min(4, Math.floor((width + COL_GAP) / (COL_MIN_W + COL_GAP))));
  const colW = (width - COL_GAP * (cols - 1)) / cols;
  const textW = colW - STROKE_W - NUM_W - 10;
  // A row is never cut (the relationship is the point): it wraps, each further line under the
  // text, not under the number. `wrapText` measures at the body size (11px), which the key draws with.
  const lines = drawn.map((r) => wrapText(keyRowText(r, model), "body", textW));
  const heights = lines.map((l) => KEY_ROW_H + (l.length - 1) * WRAP_LH);
  let svg = "";
  let height = 0;
  for (const [c, members] of columns(heights, cols).entries()) {
    const x = x0 + c * (colW + COL_GAP);
    let y = y0;
    for (const i of members) {
      const r = drawn[i];
      const mid = y - KEY_PX * 0.32;
      const dash = r.solid ? "" : ` stroke-dasharray="${stroke.dash}"`;
      svg += `<path data-key-stroke="${r.n}" d="M${num(x)} ${num(mid)} H${num(x + STROKE_W)}" fill="none" ${stroke.attrs}${dash}/>`;
      const label = String(r.n);
      const nx = x + STROKE_W + NUM_W - 6 - textWidth(label, "mono", KEY_PX - 1);
      svg += textBlock([label], nx, y, KEY_ROW_H, `data-key-n="${r.n}" font-size="${KEY_PX - 1}" ${FAM.mono} fill="${pal.muted}"`);
      svg += textBlock(lines[i], x + STROKE_W + NUM_W, y, WRAP_LH, `data-key-row="${r.n}" font-size="${KEY_PX}" ${FAM.body} fill="${pal.ink}"`);
      y += heights[i];
    }
    height = Math.max(height, y - y0);
  }
  return { svg, height };
}
