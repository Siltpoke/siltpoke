// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * /repo-graph Architecture View 2.0 — C4 model TYPES + shared accent palette.
 *
 * The authored model DATA no longer lives here. It moved to the repo's own
 * `.siltpoke/arch-c4.json` (versioned docs-as-code), is Zod-validated +
 * SSR-loaded by `src/web/arch-c4-file.ts`, and reaches the island through the
 * page payload. Detection is "file present" — the old `C4_MODEL` bundle
 * constant and its repo-name basename check are deleted; any repo becomes
 * authored by dropping the file. The model-integrity test
 * (`tests/web/islands/repo-graph-c4-model.test.ts`) now validates the
 * on-disk file.
 *
 * What remains here: the C4 type definitions every source (authored /
 * generated-adapted / subset-derived) shares, and the accent palette — a UI
 * asset of the renderer, not model content.
 */

export type C4Accent = "sky" | "terra" | "moss" | "amber";
export type C4Kind = "person" | "ext" | "cont";

export interface C4Node {
  // NOTE: a node's id is the KEY in C4Model.N — not repeated here (matches the oracle).
  kind: C4Kind;
  title: string;
  /** tech tag shown in [brackets]. */
  tech?: string;
  /** one-line purpose (from CLAUDE.md authored purposes). */
  desc?: string;
  /** layer color — cont only. */
  accent?: C4Accent;
  /** "Key pieces": [realFileName, oneLineDesc][]. cont only, surfaced in the side panel. */
  comp?: Array<[string, string]>;
  /** subdir id this container drills into. cont only; absent on person/ext (non-drillable).
   * Aggregate containers (e.g. index = repo-graph + explain) pick their PRIMARY subdir. */
  drillTo?: string;
  /** Subdir ids this container spans, when it folds MORE THAN ONE (e.g. index =
   * repo-graph + explain). The literal count badge SUMS over these so an
   * aggregate never undercounts to its primary alone. Omit for 1:1 containers
   * (the badge then falls back to drillTo, else the node id). */
  members?: string[];
  /** FILE PATHS this generated container is a summary of — the doc's evidence
   * body. GENERATED view only; field-level separation from `members` (subdir
   * ids, authored aggregates) so the two semantics can never cross-contaminate,
   * by construction, not convention. Glyph, badge, and drill all derive from
   * THIS one array. */
  memberFiles?: string[];
  /** Literal per-container counts from the index. Counts + basenames are DATA;
   * carries no interpretation. Populated at render for every cont node (any
   * view) by summing the index stats over the node's subdir set. */
  stats?: {
    fileCount: number;
    funcCount: number;
    recurringBasenames: Array<{ name: string; count: number }>;
  };
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Directed, labeled relationship: [sourceId, targetId, verbLabel]. */
export type C4Edge = [string, string, string];

export interface C4Band {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  color: string;
  /** label color. */
  lc: string;
  note: string;
  /** True when the label came from the dir→layer taxonomy
   * (a heuristic "by name" guess, not an authored/grounded name). The renderer
   * shows a secondary "by name" marker so it never reads as a grounded label. */
  heuristic?: boolean;
}

export interface C4Boundary {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface C4Model {
  N: Record<string, C4Node>;
  E: C4Edge[];
  BANDS: C4Band[];
  BOUNDARY: C4Boundary;
  GROUP_ACCENT: Record<C4Accent, string>;
}

/** Shared layer-accent palette — renderer UI asset, used by the adapter and
 * the subset deriver (the authored file carries its own copy per schema). */
export const GROUP_ACCENT: Record<C4Accent, string> = {
  sky: "#7fb0c8",
  terra: "#d96b6b",
  moss: "#7a9a5e",
  amber: "#e8a85c",
};

/** Bands keyed by the accent of the containers that live in them — used by the
 * integrity test to assert every container sits in a band by its accent. */
export const BAND_BY_ACCENT: Record<C4Accent, string> = {
  sky: "SURFACES",
  terra: "CORE",
  moss: "STATE",
  amber: "INFRA",
};
