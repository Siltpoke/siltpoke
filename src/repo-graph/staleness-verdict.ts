// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Map an IndexStaleness (or null) to a user-facing verdict. THE ONLY place the
 * threshold + level rules live — the three surfaces consume this, never re-derive.
 * See spec §4 for the rule ordering + the single combined `wrong_ratio`.
 */
import type { IndexStaleness } from "./index-health";

export type StalenessLevel = "not_indexed" | "unknown" | "fresh" | "drifting" | "stale";

export interface StalenessVerdict {
  level: StalenessLevel;
  headline: string;
  counts: {
    content_changed: number;
    deleted_still_indexed: number;
    unindexed_files: number;
    indexed: number;
    wrong_ratio: number;
  };
  caveat: string | null;
}

export function stalenessVerdict(s: IndexStaleness | null, warnPct: number): StalenessVerdict {
  // Rule 1: no index at all.
  if (s === null) {
    return { level: "not_indexed", headline: "not indexed — pick this repo on Code Map", caveat: null,
      counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, indexed: 0, wrong_ratio: 0 } };
  }
  // Rule 2: zero index rows — nothing to be stale/unknown about. Wins over read_errors.
  // Also guards the 0/0=NaN cascade before any ratio comparison.
  if (s.indexed === 0) {
    return { level: "not_indexed", headline: "not indexed — pick this repo on Code Map", caveat: null,
      counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: s.unindexed_files, indexed: 0, wrong_ratio: 0 } };
  }

  const denom = s.indexed + s.unindexed_files; // denom > 0 here since indexed > 0
  const wrongRatio = (s.content_changed + s.deleted_still_indexed + s.unindexed_files) / denom;
  const caveat = s.read_errors > 0 ? `numbers cover ${s.read_errors} fewer file(s) that could not be read` : null;
  const pct = Math.round(wrongRatio * 100);
  const counts = {
    content_changed: s.content_changed,
    deleted_still_indexed: s.deleted_still_indexed,
    unindexed_files: s.unindexed_files,
    indexed: s.indexed,
    wrong_ratio: wrongRatio,
  };

  // Rule 3: provably stale — evaluated BEFORE read_errors so a real ≥warn signal
  // is never softened to "unknown". Caveat still flags the incomplete measurement.
  if (wrongRatio >= warnPct) {
    const at = s.read_errors > 0 ? "at least " : "";
    return { level: "stale", headline: `${at}${pct}% out of date — re-index recommended`, counts, caveat };
  }
  // Rule 4: measurement incomplete and not already stale.
  if (s.read_errors > 0) {
    return { level: "unknown", headline: "index freshness unknown — some files could not be read", counts, caveat };
  }
  // Rule 5: some drift below the gate.
  if (s.content_changed + s.deleted_still_indexed + s.unindexed_files > 0) {
    return { level: "drifting", headline: `${pct}% drifted since indexing`, counts, caveat: null };
  }
  // Rule 6: clean.
  return { level: "fresh", headline: "index is current", counts, caveat: null };
}
