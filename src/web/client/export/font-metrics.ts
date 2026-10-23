// Real advance widths of the vendored export fonts (public/static/fonts), in
// thousandths of an em. Measured 2026-09-29 in Chromium with canvas
// measureText at 1000px against the same .woff2 files the export embeds, so a
// width computed here is the width the image draws (kerning aside — callers
// keep a small slack for it). Printable ASCII is indexed from U+0020; the few
// non-ASCII characters the export itself writes are listed by hand. JetBrains
// Mono is monospaced: every glyph measured 600.

/** U+0020..U+007E, Geist Regular (400). */
const GEIST_400 = [
  250, 213, 346, 478, 629, 802, 620, 178, 274, 274, 430, 558, 201, 419, 201, 480, 663, 384, 619, 613, 615, 626, 593, 524,
  604, 593, 297, 297, 544, 540, 544, 559, 906, 668, 680, 703, 694, 603, 590, 700, 713, 270, 597, 640, 580, 877, 743, 739,
  650, 733, 672, 640, 552, 689, 667, 945, 606, 576, 544, 347, 455, 347, 426, 557, 248, 551, 595, 546, 595, 561, 395, 594,
  581, 244, 260, 590, 267, 877, 581, 573, 595, 595, 379, 520, 392, 575, 536, 819, 585, 537, 537, 389, 264, 389, 523,
];

/** U+0020..U+007E, Geist Medium (500). */
const GEIST_500 = [
  243, 228, 361, 515, 643, 810, 649, 186, 290, 290, 427, 562, 213, 418, 213, 494, 673, 406, 630, 625, 629, 641, 604, 531,
  624, 606, 302, 302, 546, 544, 546, 570, 925, 689, 688, 713, 701, 609, 595, 713, 716, 280, 607, 656, 583, 890, 745, 751,
  657, 745, 680, 654, 568, 694, 688, 968, 633, 594, 561, 361, 470, 361, 438, 558, 258, 565, 608, 563, 608, 576, 412, 607,
  591, 256, 284, 609, 282, 885, 591, 588, 608, 608, 394, 537, 410, 586, 560, 829, 607, 553, 552, 395, 274, 395, 523,
];

/** Non-ASCII characters the export writes: · — – × → ← " " ' ' • … */
const EXTRA_400: Record<string, number> = { "·": 201, "—": 907, "–": 591, "×": 502, "→": 800, "←": 800, "“": 368, "”": 368, "‘": 203, "’": 203, "•": 312, "…": 571 };
const EXTRA_500: Record<string, number> = { "·": 213, "—": 908, "–": 592, "×": 515, "→": 798, "←": 798, "“": 399, "”": 399, "‘": 218, "’": 218, "•": 329, "…": 612 };

export type MetricFace = "geist400" | "geist500" | "mono";

/** Advance of one narrow (non-CJK, non-emoji) character in em thousandths; an
 * unlisted character is taken as a wide Latin glyph (700) so it never under-measures. */
export function advanceMilli(ch: string, face: MetricFace): number {
  if (face === "mono") return 600;
  const cp = ch.codePointAt(0) ?? 0;
  const table = face === "geist400" ? GEIST_400 : GEIST_500;
  if (cp >= 0x20 && cp <= 0x7e) return table[cp - 0x20];
  return (face === "geist400" ? EXTRA_400 : EXTRA_500)[ch] ?? 700;
}
