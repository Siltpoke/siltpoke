// The export SVG (spec §7.2): a self-contained image built from the active
// C4Model's own layout plus the trust map. Pure string building — no DOM, no
// measuring (layout-text.ts uses the vendored fonts' measured advances). Every text node and
// every attribute that carries model data goes through esc(). The on-screen
// "Key pieces" (`comp`) are never drawn (§12). Every box shows its description; every
// edge carries a number, and the key under the diagram says what each one is (spec
// §7.2, amended 2026-09-29, second pass). The stamp wording comes from the server.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model } from "../islands/repo-graph-c4-model";
import { BADGE_PX, placeBadge } from "./edge-labels";
import { edgeNumbers, listedEdges } from "./edge-list";
import { wrapText } from "./layout-text";
import { bandTitleBox, boundaryLabelBox, renderBand, renderBoundary, renderBox } from "./svg-box";
import { contentBounds, edgeGeoms } from "./svg-geom";
import { type SvgPalette, svgPalette } from "./svg-style";
import { renderKey } from "./svg-key";
import { esc, FAM, num, textBlock } from "./svg-text";

type Theme = "light" | "dark";

const PAD = 24;
const HEADER_H = 76;
const MIN_W = 720;
const LH = 15; // footer / header body line height

const LEGEND_SOLID = "── solid: an import, or a source citation checked at export";
const LEGEND_DASHED = "- - dashed: neither";
const LEGEND_COUNT = 'In each box, "5 of 39 files" = files the AI listed / files in that folder.';
const LEGEND_AI = "Group titles and descriptions are AI-written and unverified.";
const LEGEND_SUBSET = "Every edge in this view is a real import.";
const NOT_SHOWN_MAX = 6;
// The page draws resting edges in --ink3 at 0.32; the export keeps the colour but
// holds more of it, so a dashed line still reads as dashed once shrunk (the trust signal).
const EDGE_OPACITY = 0.55;
const EDGE_W = 1.2;
const BOX_TEXT_INSET = 12; // a card's text starts this far in (svg-box.ts PAD)
const EDGE_DASH = "4 3"; // the page's dash; with butt caps the 3px gap is really drawn
const STROKE = (pal: SvgPalette): string => `stroke="${pal.faint}" stroke-opacity="${EDGE_OPACITY}" stroke-width="${EDGE_W}"`;
// Butt caps on the line: a round cap adds half the width to each end of every dash and eats the gap,
// so a shrunk dashed edge (the trust signal) would read as solid. Round caps only on the arrowhead.
const LINE_STROKE = (pal: SvgPalette): string => `${STROKE(pal)} stroke-linecap="butt"`;
const HEAD_STROKE = (pal: SvgPalette): string => `${STROKE(pal)} stroke-linecap="round" stroke-linejoin="round"`;
const VIEW_NAME = { generated: "Generated", authored: "Authored", subset: "Subset" } as const;

interface EdgeLayer {
  lines: string;
  badges: string;
  allSolid: boolean;
  /** Badges that found no free spot on their curve and sit where they overlap least. */
  crowded: number;
}

function renderEdges(model: C4Model, trust: TrustMap, pal: SvgPalette, nums: Array<number | null>): EdgeLayer {
  const solidOf = new Map(trust.edges.map((e) => [`${e.source}>${e.target}`, e.solid]));
  // A badge keeps off every box's text, every band name and the boundary name (review M2). A box
  // counts from inside its padding: a badge may sit over a card's border, never over its words.
  const bo = boundaryLabelBox(model.BOUNDARY);
  const text = Object.values(model.N).map((n) => ({ x: n.x + BOX_TEXT_INSET, y: n.y + 8, w: n.w - 2 * BOX_TEXT_INSET, h: n.h - 16 }));
  const obstacles = [...text, ...model.BANDS.map(bandTitleBox), ...(bo ? [bo] : [])];
  const geoms = edgeGeoms(model);
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  let lines = "";
  let badges = "";
  let drawn = 0;
  let solid = 0;
  let crowded = 0;
  // Badges are placed in number order, so a crowded spot goes to the higher number.
  const order = model.E.map((_, i) => i).filter((i) => nums[i] !== null && geoms[i]);
  order.sort((a, b) => (nums[a] ?? 0) - (nums[b] ?? 0));
  for (const i of order) {
    const [s, t] = model.E[i];
    const g = geoms[i] as NonNullable<(typeof geoms)[number]>;
    const n = nums[i] as number;
    // No trust record = nothing corroborated it: dashed, like any unbacked edge.
    const isSolid = solidOf.get(`${s}>${t}`) === true;
    drawn++;
    if (isSolid) solid++;
    const dash = isSolid ? "" : ` stroke-dasharray="${EDGE_DASH}"`;
    const key = `"${esc(s)}" data-to="${esc(t)}" data-n="${n}"`;
    const [p1, c, p2] = g.curve;
    const pt = (p: [number, number]): string => `${num(p[0])} ${num(p[1])}`;
    lines += `<path data-edge=${key} d="M${pt(p1)} Q${pt(c)} ${pt(p2)}" fill="none" ${LINE_STROKE(pal)}${dash}/>`;
    lines += `<path data-arrow=${key} d="M${pt(g.head[0])} L${pt(g.head[1])} L${pt(g.head[2])}" fill="none" ${HEAD_STROKE(pal)}/>`;
    const b = placeBadge(String(n), g.curve, obstacles, placed);
    if (!b.clear) crowded++;
    badges +=
      `<rect data-badge="${n}" x="${num(b.box.x + 0.5)}" y="${num(b.box.y + 0.5)}" width="${num(b.box.w - 1)}" height="${num(b.box.h - 1)}" rx="6" fill="${pal.bg}" stroke="${pal.faint}" stroke-width="1"/>` +
      textBlock([String(n)], b.centre[0], b.baseline, LH, `text-anchor="middle" font-size="${BADGE_PX}" ${FAM.mono} fill="${pal.muted}"`);
  }
  return { lines, badges, allSolid: drawn > 0 && solid === drawn, crowded };
}

function renderHeader(trust: TrustMap, stampLine: string, pal: SvgPalette, width: number): string {
  const innerW = width - PAD * 2;
  const stamp = wrapText(stampLine, "body", innerW);
  const out = [
    textBlock([`Code Map · ${VIEW_NAME[trust.source]} view`], PAD, 28, LH, `font-size="16" ${FAM.display} fill="${pal.ink}"`),
    textBlock(stamp, PAD, 48, LH, `font-size="11" ${FAM.body} fill="${pal.muted}"`),
  ];
  if (trust.totals) {
    const y = 48 + stamp.length * LH;
    out.push(textBlock([`AI listed ${trust.totals.listed} of ${trust.totals.total} files`], PAD, y, LH, `font-size="11" ${FAM.body} fill="${pal.ink}"`));
  }
  return out.join("");
}

function notShownLine(folders: string[]): string {
  const shown = folders.slice(0, NOT_SHOWN_MAX).join(", ");
  const more = folders.length - NOT_SHOWN_MAX;
  return `Not shown: ${shown}${more > 0 ? ` +${more} more` : ""}`;
}

interface FooterFacts {
  allSolid: boolean;
}

function renderFooter(trust: TrustMap, y0: number, width: number, pal: SvgPalette, f: FooterFacts): { svg: string; bottom: number } {
  let y = y0;
  let svg = "";
  if (trust.notShown.length) {
    const lines = wrapText(notShownLine(trust.notShown), "body", width - PAD * 2);
    svg += textBlock(lines, PAD, y, LH, `font-size="11" ${FAM.body} fill="${pal.muted}"`);
    y += lines.length * LH + 8;
  }
  const legend = [LEGEND_SOLID, LEGEND_DASHED];
  if (trust.source === "generated") legend.push(LEGEND_COUNT);
  legend.push(LEGEND_AI);
  // Derived from what is drawn, not assumed from the view: said only when every drawn edge is solid.
  if (trust.source === "subset" && f.allSolid) legend.push(LEGEND_SUBSET);
  for (const l of legend) {
    svg += textBlock([l], PAD, y, LH, `font-size="11" ${FAM.body} fill="${pal.muted}"`);
    y += LH;
  }
  return { svg, bottom: y };
}

export function buildExportSvg(
  model: C4Model,
  trust: TrustMap,
  opts: { theme: Theme; fontCss: string; stampLine: string; appendix?: boolean },
): { svg: string; width: number; height: number } {
  const pal = svgPalette(opts.theme);
  const bounds = contentBounds(model);
  const width = Math.max(MIN_W, Math.ceil(bounds.w + 28));
  const byId = new Map(trust.containers.map((c) => [c.id, c]));
  const nums = edgeNumbers(model); // once: the badges and the key must agree
  const edges = renderEdges(model, trust, pal, nums);
  const boundary = renderBoundary(model.BOUNDARY, pal);
  const boxes = Object.entries(model.N)
    .map(([id, n], i) => renderBox(id, i, n, byId.get(id), model, pal, opts.theme))
    .join("");
  const bands = model.BANDS.map((b) => renderBand(b, pal, opts.theme)).join("");
  // The key: every numbered edge, under the diagram (nothing is left out any more).
  const keyTop = HEADER_H + bounds.h + 28;
  const key = renderKey(listedEdges(model, trust, nums), model, PAD, keyTop, width - PAD * 2, pal, { attrs: LINE_STROKE(pal), dash: EDGE_DASH });
  const footer = renderFooter(trust, keyTop + key.height + (key.height ? 14 : -4), width, pal, { allSolid: edges.allSolid });
  const height = footer.bottom + PAD;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    // `<` cannot occur in @font-face rules; dropping it keeps a stray "</style>" from closing the block.
    `<defs><style>${opts.fontCss.replaceAll("<", "")}</style></defs>` +
    `<rect width="${width}" height="${height}" fill="${pal.bg}"/>` +
    renderHeader(trust, opts.stampLine, pal, width) +
    `<g transform="translate(0 ${HEADER_H})">${boundary}${bands}${edges.lines}${boxes}${edges.badges}</g>` +
    key.svg +
    footer.svg +
    `</svg>`;
  return { svg, width, height };
}
