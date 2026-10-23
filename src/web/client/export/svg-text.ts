// Markup helpers shared by the export SVG builders: escaping, number
// formatting, multi-line <text>, and the font stacks. Every string drawn from
// the model goes through esc().

export const FAM = {
  display: `font-family="'Pixelify Sans', monospace" font-weight="600"`,
  title: `font-family="Geist, sans-serif" font-weight="500"`,
  body: `font-family="Geist, sans-serif" font-weight="400"`,
  mono: `font-family="'JetBrains Mono', monospace" font-weight="400"`,
} as const;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const num = (v: number): string => String(Math.round(v * 10) / 10);

/** A <text> whose lines are <tspan>s; `attrs` is trusted static markup or already-escaped values. */
export function textBlock(lines: string[], x: number, y: number, lh: number, attrs: string): string {
  const spans = lines.map((l, i) => `<tspan x="${num(x)}" dy="${i === 0 ? 0 : lh}">${esc(l)}</tspan>`).join("");
  return `<text x="${num(x)}" y="${num(y)}" ${attrs}>${spans}</text>`;
}
