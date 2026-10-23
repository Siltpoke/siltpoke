// Source chip: the first segment's label + tooltip. Extracted from
// repo-graph.ts (whose length pin only moves down) when the Export button
// was wired in beside it.

/** Label + tooltip are constant after boot (hasAuthored never changes for a
 * mounted repo) — write only on change so render()-frequency calls stay no-op. */
export function labelAuthoredSeg(seg: HTMLElement | null, hasAuthored: boolean): void {
  if (!seg) return;
  const label = hasAuthored ? "Authored" : "Auto";
  if (seg.textContent === label) return;
  seg.textContent = label;
  seg.title = hasAuthored
    ? "Hand-authored architecture (.siltpoke/arch-c4.json)"
    : "Derived from project structure — deterministic, no AI";
}
