// Measure-free text wrapping (spec §7.2, §11): the vendored fonts' real
// advance widths (font-metrics.ts) instead of canvas measuring, so the pure
// builder needs no DOM. Sizes are the ones build-svg draws with: title 13.5px
// (Geist Medium), body 11px (Geist Regular), mono 10px (JetBrains Mono).
import { advanceMilli, type MetricFace } from "./font-metrics";

type Font = "title" | "body" | "mono";

const FONT: Record<Font, { px: number; face: MetricFace }> = {
  title: { px: 13.5, face: "geist500" },
  body: { px: 11, face: "geist400" },
  mono: { px: 10, face: "mono" },
};
/** Kerning and rounding headroom on the measured sum (2%). */
const SLACK = 1.02;

/** CJK, Hangul, fullwidth forms and emoji: outside the table, so one full em. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f000
  );
}

function advance(ch: string, font: Font): number {
  const { px, face } = FONT[font];
  const cp = ch.codePointAt(0) ?? 0;
  if (isWide(cp)) return px;
  return (advanceMilli(ch, face) / 1000) * px * SLACK;
}

const width = (s: string, font: Font): number => Array.from(s).reduce((a, ch) => a + advance(ch, font), 0);

/** Estimated width of `s` when drawn at `px` (the table is per-font; other sizes scale linearly). */
export const textWidth = (s: string, font: Font, px: number = FONT[font].px): number => (width(s, font) * px) / FONT[font].px;

/** Cut `text` to fit `maxWidth` by code point (never splits a surrogate pair), ending in `…` when it had to cut. */
export function fitText(text: string, font: Font, maxWidth: number): string {
  if (width(text, font) <= maxWidth) return text;
  const room = maxWidth - advance("…", font);
  let out = "";
  let w = 0;
  for (const ch of Array.from(text)) {
    const a = advance(ch, font);
    if (w + a > room) break;
    out += ch;
    w += a;
  }
  return `${out}…`;
}

// Whitespace run | one wide char (breakable anywhere) | a run of narrow chars.
const TOKEN = /\s+|[\u1100-\u11ff\u2e80-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\ud800-\udbff][\udc00-\udfff]|[^\s\u1100-\u11ff\u2e80-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\ud800-\udbff]+/g;

export function wrapText(text: string, font: Font, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  let w = 0;
  const flush = (): void => {
    lines.push(line.trimEnd());
    line = "";
    w = 0;
  };
  const put = (s: string, sw: number): void => {
    if (w + sw > maxWidth && line !== "") flush();
    line += s;
    w += sw;
  };
  for (const tok of text.match(TOKEN) ?? []) {
    if (/^\s+$/.test(tok)) {
      if (line !== "" && w + advance(" ", font) <= maxWidth) put(" ", advance(" ", font));
      continue;
    }
    const tw = width(tok, font);
    if (tw <= maxWidth || Array.from(tok).length === 1) put(tok, tw);
    else for (const ch of Array.from(tok)) put(ch, advance(ch, font)); // unbreakable run: split by code point
  }
  if (line !== "" || lines.length === 0) flush();
  return lines;
}
