// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

export function visibleWidth(s: string): number {
  const stripped = stripAnsi(s);
  return [...stripped].length;
}

export function visibleWidthOfWidestLine(s: string): number {
  return s.split("\n").reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  );
}

export function visualWidth(s: string): number {
  const stripped = stripAnsi(s);
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    w += isWideCodePoint(cp) ? 2 : 1;
  }
  return w;
}

export function truncateToVisualWidth(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const cw = isWideCodePoint(cp) ? 2 : 1;
    if (w + cw > maxWidth) break;
    w += cw;
    out += ch;
  }
  return out;
}
