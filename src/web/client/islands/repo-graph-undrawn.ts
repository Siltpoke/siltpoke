// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The header's "N files not in this diagram" line (`#rg-undrawn`).
 *
 * The header counts every indexed file; the current view's boxes can hold
 * fewer (`src/repo-graph/undrawn-files.ts` says which). This writes that
 * difference beside the count instead of leaving it silent. Kept out of
 * `repo-graph.ts` so that pinned file only grows by its wiring lines.
 */
import type { UndrawnSummary } from "../../../repo-graph/undrawn-files";

/** At or under this many, the line names the files; above it, it counts them
 * and the full list sits in the hover title. */
export const UNDRAWN_INLINE_MAX = 3;

export interface UndrawnLine {
  text: string;
  title: string;
}

/** The line for one view, or null when the view draws every file. */
export function undrawnLine(s: UndrawnSummary | null | undefined): UndrawnLine | null {
  if (!s || s.count === 0) return null;
  const noun = s.count === 1 ? "file" : "files";
  const more = s.count - s.examples.length;
  const title = s.examples.join("\n") + (more > 0 ? `\n…and ${more} more` : "");
  if (s.count <= UNDRAWN_INLINE_MAX) {
    return { text: `· ${s.count} ${noun} not in this diagram: ${s.examples.join(", ")}`, title };
  }
  return { text: `· ${s.count} ${noun} not in this diagram`, title };
}

/** Fill or hide the header line. `s` is the current view's summary; pass null
 * for a view this line does not cover (Authored, or off the architecture level). */
export function updateUndrawn(el: HTMLElement | null, s: UndrawnSummary | null | undefined): void {
  if (!el) return;
  const line = undrawnLine(s);
  el.hidden = line === null;
  el.textContent = line?.text ?? "";
  el.title = line?.title ?? "";
}
