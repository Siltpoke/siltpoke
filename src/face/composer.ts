// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { visibleWidthOfWidestLine } from "./width";

export interface ComposeOptions {
  face: string;
  inner: string;
  termWidth: number;
}

const GUTTER = " ";

export function composeOutput(opts: ComposeOptions): string {
  const { face, inner, termWidth } = opts;

  // No face → nothing to splice, pass the inner line through. Face but no
  // inner (fresh install with no prior statusline to chain) → render the face
  // standalone rather than dropping it.
  if (!face) return inner;
  if (!inner) return face;

  const faceLines = face.split("\n");
  const innerLines = inner.split("\n");
  const faceWidth = visibleWidthOfWidestLine(face);
  const innerWidth = visibleWidthOfWidestLine(inner);
  const combinedWidth = faceWidth + GUTTER.length + innerWidth;

  if (termWidth > 0 && combinedWidth > termWidth) {
    return inner;
  }

  const rows = Math.max(faceLines.length, innerLines.length);
  const out: string[] = [];
  // U+2800 BRAILLE PATTERN BLANK is a real character — not whitespace per
  // Unicode White_Space property — so Claude Code's statusline renderer
  // does not trim it or collapse it. Most modern terminals render it as
  // a 1-column blank glyph. We use it for indent on blank face rows so
  // bubble continuation lines visually align under the bubble start.
  const INDENT_CHAR = "⠀";

  for (let i = 0; i < rows; i++) {
    const faceLine = faceLines[i];
    const innerLine = innerLines[i] ?? "";
    if (faceLine === undefined || faceLine.trim() === "") {
      const indentWidth = faceWidth + GUTTER.length;
      out.push(`${INDENT_CHAR.repeat(indentWidth)}${innerLine}`);
    } else {
      const facePadded = faceLine.padEnd(faceWidth, " ");
      out.push(`${facePadded}${GUTTER}${innerLine}`);
    }
  }

  return out.join("\n");
}
