// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure label builders for the honest-subset container view — the ONE place
 * badge/breakdown TEXT is constructed, so the zero-name guard covers all
 * label vocabulary in a single file.
 *
 * Every word written here is GENERIC ("files", "fn", "× ", the no-pattern
 * line); the counts and basenames are runtime DATA threaded from the index,
 * never literals. The renderer (`repo-graph.ts`) calls these and draws the
 * result — it carries no label string of its own. (two-layer discipline.)
 */
import type { ContainerStats } from "./container-stats";

/** "229 files" / "1 file" or "… · 122 fn". Generic words only; counts are
 * data. Singular became reachable once member-badges count one container's
 * OWN files (badge-door-members M1). */
export function badgeLabel(s: ContainerStats): string {
  const filePart = s.fileCount === 1 ? "1 file" : `${s.fileCount} files`;
  return s.funcCount > 0 ? `${filePart} · ${s.funcCount} fn` : filePart;
}

/** Breakdown rows: "46× page.tsx" (basename is DATA) or the no-pattern line. */
export function breakdownRows(s: ContainerStats): string[] {
  if (s.recurringBasenames.length === 0) {
    return ["no recurring filename pattern"];
  }
  return s.recurringBasenames.map((b) => `${b.count}× ${b.name}`);
}
