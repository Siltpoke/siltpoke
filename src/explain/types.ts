// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Explain pipeline types.
 */
import type { BrainUsage } from "../brain/brain";

export const EXPLANATION_SCHEMA_VERSION = 1 as const;

export interface ExplanationMeta {
  schemaVersion: typeof EXPLANATION_SCHEMA_VERSION;
  /** User input verbatim. */
  target: string;
  /** Resolved repo-graph node id. */
  target_node_id: string;
  /** sha256(target_node_id)[:12] — also the file basename. */
  target_key_sha256: string;
  /**
   * Copied from repo-graph meta.json `last_indexed_ts` — cache invalidator.
   * Mismatch on read means the graph was re-indexed since this explanation
   * was written; treat as cache miss.
   */
  graph_indexed_ts: string;
  brain_usage: BrainUsage;
  /** Grounded citations / total citations, in `[0, 1]`. */
  evidence_score: number;
  /** True iff `evidence_score < 0.9` (soft threshold). */
  low_confidence: boolean;
  depth: 1 | 2;
  /** ISO 8601 timestamp of explanation creation. */
  created_ts: string;
  /**
   * content_sha256 of the target's source file at
   * the time this explanation was generated. Read from the index's
   * `fingerprints.json` by the orchestrator. Cache reader (`cache.ts`)
   * compares against current fingerprints to detect file changes since
   * cache; mismatch (or missing field on an older cache entry) is
   * treated as a miss so the next call regenerates against fresh source.
   * Backward-compat preserved by leaving the field optional.
   */
  source_fingerprint?: string;
}

export interface ExplainResult {
  /** Absolute path to the persisted markdown file. */
  mdPath: string;
  /** Absolute path to the sidecar `.meta.json`. */
  metaPath: string;
  /** The markdown body. */
  markdown: string;
  /** The persisted meta record. */
  meta: ExplanationMeta;
  /** Whether the result was served from cache (vs freshly built). */
  fromCache: boolean;
}

// Note: the orchestrator's request shape lives next to its implementation in
// `src/explain/explain.ts` as `ExplainOptions`. An earlier draft of this file
// shipped a stale duplicate (with a `cwd` field that was later moved into
// `ExplainCtx`); that copy was unused and has been removed to avoid drift.
