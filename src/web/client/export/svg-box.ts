// The export's boxes, bands and system boundary, drawn the way the on-screen C4
// view draws them (RepoGraph.tsx `.c4-node` / `.c4-band` / `.c4-boundary`): a
// light card with a hairline border and a coloured left bar, a Geist title, up to
// two lines of the group's description (the AI-written text the page shows), and
// one short muted line per folder. Outside-system boxes are dashed on the darker
// paper, a person is the dark card.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model, C4Node } from "../islands/repo-graph-c4-model";
import { fitText, textWidth, wrapText } from "./layout-text";
import { resolveColor, type SvgPalette } from "./svg-style";
import { esc, FAM, num, textBlock } from "./svg-text";

type Theme = "light" | "dark";
type TrustContainer = TrustMap["containers"][number];
type Folder = TrustContainer["folders"][number];

const RADIUS = 10;
const BAR = 4; // the accent bar's width (page: border-left 4px)
const PAD = 12; // page: padding 10px 12px
const TITLE_PX = 13.5;
const TITLE_LH = 17;
const META_PX = 10.5;
const META_LH = 14;
const GAP = 4; // between the title and the first meta line
const BAND_FALLBACK_OPACITY = 0.1; // an unrecognised band colour is a faint wash, never an opaque slab

/** `fitText` measures at the body size (11px); a meta line is drawn at 10.5px. */
const fitMeta = (s: string, w: number): string => fitText(s, "body", (w * 11) / META_PX);
const metaWidth = (s: string): number => textWidth(s, "body", META_PX);

/** `src/daemon · 5 of 39 files` — the path gives way before the count does. */
function folderLine(f: Folder, maxW: number): string {
  const suffix = f.listed === null ? "" : ` · ${f.listed} of ${f.total} files`;
  const room = maxW - metaWidth(suffix);
  return room < 24 ? fitMeta(f.folder + suffix, maxW) : fitMeta(f.folder, room) + suffix;
}

/** The folder lines, `room` of them at most: past that the last line says how many more. */
function folderLines(c: TrustContainer | undefined, maxW: number, room: number): string[] {
  const lines = (c?.folders ?? []).map((f) => folderLine(f, maxW));
  if (room < 1) return [];
  if (lines.length <= room) return lines;
  const keep = room - 1;
  return [...lines.slice(0, keep), `+${lines.length - keep} more folders`];
}

/** How the text rows under the title are shared (spec §7.2, amended 2026-09-29, second pass):
 * a group's description gets up to 2 rows and its folders the rest, each folder keeping a row
 * of its own where it can; an outside-system / person box gives every row to its description. */
function shareRows(n: C4Node, c: TrustContainer | undefined, descAll: string[], room: number): { desc: number; folders: number } {
  if (n.kind !== "cont") return { desc: Math.min(descAll.length, room), folders: 0 };
  const want = c?.folders.length ?? 0;
  if (!descAll.length) return { desc: 0, folders: room };
  if (!want) return { desc: Math.min(2, descAll.length, room), folders: 0 };
  const desc = Math.min(2, descAll.length, Math.max(room >= 2 ? 1 : 0, room - want));
  return { desc, folders: room - desc };
}

interface Look {
  fill: string;
  stroke: string;
  dash: string;
  bar: string | null;
  ink: string;
  meta: string;
  metaOpacity: string;
}

function look(n: C4Node, model: C4Model, pal: SvgPalette, theme: Theme): Look {
  if (n.kind === "person") return { fill: pal.ink, stroke: pal.ink, dash: "", bar: null, ink: pal.bg, meta: pal.bg, metaOpacity: ` fill-opacity="0.7"` };
  if (n.kind === "ext") return { fill: pal.ext, stroke: pal.faint, dash: ` stroke-dasharray="4 3"`, bar: null, ink: pal.ink, meta: pal.muted, metaOpacity: "" };
  const bar = n.accent ? resolveColor(model.GROUP_ACCENT[n.accent] ?? "", theme).color : null;
  return { fill: pal.bg, stroke: pal.rule, dash: "", bar, ink: pal.ink, meta: pal.muted, metaOpacity: "" };
}

export function renderBox(id: string, i: number, n: C4Node, c: TrustContainer | undefined, model: C4Model, pal: SvgPalette, theme: Theme): string {
  const L = look(n, model, pal, theme);
  const ident = n.kind === "cont" ? `data-id="${esc(id)}"` : `data-node="${esc(id)}" data-kind="${esc(n.kind)}"`;
  const geo = `x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${RADIUS}"`;
  const parts = [`<rect ${ident} ${geo} fill="${L.fill}" stroke="${L.stroke}" stroke-width="1"${L.dash}/>`];
  if (L.bar) {
    parts.push(`<clipPath id="k${i}"><rect ${geo}/></clipPath>`);
    parts.push(`<rect data-for="${esc(id)}" data-role="bar" x="${n.x}" y="${n.y}" width="${BAR}" height="${n.h}" fill="${L.bar}" clip-path="url(#k${i})"/>`);
  }
  const left = n.x + (L.bar ? BAR : 1) + PAD;
  const inner = n.w - (left - n.x) - PAD;
  const usable = n.h - 20;
  const descAll = n.desc ? wrapText(n.desc, "body", (inner * 11) / META_PX) : [];
  const hasMeta = descAll.length > 0 || (n.kind === "cont" && !!c?.folders.length);
  // With anything under it, a title keeps to 2 lines so the description has room.
  const titleCap = Math.floor((usable - (hasMeta ? GAP + META_LH : 0)) / TITLE_LH);
  const titleAll = wrapText(n.title, "title", inner);
  const title = titleAll.slice(0, Math.max(1, hasMeta ? Math.min(2, titleCap) : titleCap));
  // A cut title ends in "…" on a line re-fitted by measured width, so the ellipsis never overflows.
  if (titleAll.length > title.length) title[title.length - 1] = fitText(titleAll.slice(title.length - 1).join(" "), "title", inner - 1);
  const room = hasMeta ? Math.floor((usable - title.length * TITLE_LH - GAP) / META_LH) : 0;
  const rows = shareRows(n, c, descAll, room);
  const desc = descAll.slice(0, rows.desc);
  // A cut description ends in "…" on a line re-fitted by measured width, so the ellipsis never overflows.
  if (desc.length && descAll.length > desc.length) desc[desc.length - 1] = fitMeta(`${descAll.slice(desc.length - 1).join(" ")}`, inner - 1);
  const folders = n.kind === "cont" ? folderLines(c, inner, rows.folders) : [];
  // The block is centred in the card: the model's height is kept (geometry parity), the text is not stranded at the top.
  const metaN = desc.length + folders.length;
  const blockH = title.length * TITLE_LH + (metaN ? GAP + metaN * META_LH : 0);
  const top = n.y + Math.max(10, (n.h - blockH) / 2);
  const tAttrs = `data-for="${esc(id)}" data-role="title" font-size="${TITLE_PX}" ${FAM.title} fill="${L.ink}"`;
  parts.push(textBlock(title, left, top + 12.5, TITLE_LH, tAttrs));
  const y0 = top + title.length * TITLE_LH + GAP + 10;
  const meta = (lines: string[], y: number, role: string, fill: string): void => {
    if (lines.length) parts.push(textBlock(lines, left, y, META_LH, `data-for="${esc(id)}" data-role="${role}" font-size="${META_PX}" ${FAM.body} fill="${fill}"${L.metaOpacity}`));
  };
  meta(desc, y0, "desc", L.meta);
  // The folder line stays last, one step quieter than the description.
  meta(folders, y0 + desc.length * META_LH, "folders", n.kind === "cont" ? pal.faint : L.meta);
  return parts.join("");
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The ink a band's name covers (baseline y+18, mono 10px, 1px letter-spacing, the "by name" tag) — an edge label keeps off it. */
export function bandTitleBox(b: C4Model["BANDS"][number]): Rect {
  const chars = Array.from(b.label).length;
  const w = textWidth(b.label, "mono", 10) + chars + (b.heuristic ? textWidth(" by name", "mono", 8) + 8 : 0);
  return { x: b.x + 12, y: b.y + 8, w: w + 4, h: 14 };
}

/** The knocked-out strip the boundary's name sits in, on the top border. */
export function boundaryLabelBox(bo: C4Model["BOUNDARY"]): Rect | null {
  if (bo.w <= 0 || !bo.label) return null;
  return { x: bo.x + 18, y: bo.y - 8, w: textWidth(bo.label, "mono", 11) + 16, h: 16 };
}

export function renderBand(b: C4Model["BANDS"][number], pal: SvgPalette, theme: Theme): string {
  const fill = resolveColor(b.color, theme, BAND_FALLBACK_OPACITY);
  const lc = resolveColor(b.lc, theme).color;
  // Upper case is a style, not a rewrite: the text stays as written, so the privacy and secret scans read what the model holds.
  const byName = b.heuristic ? `<tspan font-size="8" letter-spacing="0.3" fill="${pal.faint}" style="text-transform:none"> by name</tspan>` : "";
  return (
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="11" fill="${fill.color}" fill-opacity="${fill.opacity}"/>` +
    `<text x="${num(b.x + 14)}" y="${num(b.y + 18)}" font-size="10" letter-spacing="1" ${FAM.mono} fill="${lc}" style="text-transform:uppercase">${esc(b.label)}${byName}</text>`
  );
}

/** Dashed rounded frame with its name sitting on the top border, knocked out of the line. */
export function renderBoundary(bo: C4Model["BOUNDARY"], pal: SvgPalette): string {
  if (bo.w <= 0) return "";
  const lab = boundaryLabelBox(bo);
  return (
    `<rect data-role="boundary" x="${bo.x}" y="${bo.y}" width="${bo.w}" height="${bo.h}" rx="14" fill="none" stroke="${pal.faint}" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="6 4"/>` +
    (lab
      ? `<rect x="${num(lab.x)}" y="${num(lab.y)}" width="${num(lab.w)}" height="${lab.h}" fill="${pal.bg}"/>` +
        textBlock([bo.label], bo.x + 26, bo.y + 4, 15, `font-size="11" ${FAM.mono} fill="${pal.muted}"`)
      : "")
  );
}
