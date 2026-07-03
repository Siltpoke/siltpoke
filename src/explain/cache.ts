// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Explanation cache lookup.
 *
 * Coarse cache invalidation = `graph_indexed_ts` from the index's
 * `meta.json`. Re-indexing the graph (`/siltpoke-index`) changes the
 * timestamp, which causes the next explain call to miss and re-Brain.
 *
 * Fine-grained cache invalidation via the target's
 * source file fingerprint. When the caller passes a non-empty
 * `expectedSourceFingerprint`, the cached meta's `source_fingerprint`
 * must match — missing OR mismatching is treated as a miss (self-heal:
 * older entries without the field regenerate once). Bonus: fixes a
 * latent bug where source edits between graph re-index events
 * left stale explanations as valid.
 *
 * `--force` bypass is implemented at the orchestrator layer (it simply
 * skips this lookup), so this module need not know about it.
 */

import { readExplanation } from "./store";
import type { ExplainResult } from "./types";

export async function readCachedExplanation(
  cwd: string,
  key: string,
  expectedGraphIndexedTs: string,
  expectedSourceFingerprint?: string,
): Promise<ExplainResult | null> {
  if (!expectedGraphIndexedTs) return null;
  const cached = await readExplanation(cwd, key);
  if (!cached) return null;
  if (cached.meta.graph_indexed_ts !== expectedGraphIndexedTs) return null;
  // Skip fingerprint check when caller passes nothing OR empty string
  // (backward-compat for callers not yet wired through the orchestrator).
  if (expectedSourceFingerprint) {
    if (cached.meta.source_fingerprint !== expectedSourceFingerprint) return null;
  }
  return cached;
}
