// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Explanation cache lifecycle state
 * machine + cascade invalidation for the /repo-graph UI.
 *
 * State derivation per cached entry:
 *
 *   NoCache — no `<key>.meta.json` file exists for the target
 *   Cached  — meta present AND `source_fingerprint` matches the
 *             current fingerprint for the target's source file
 *   Stale   — meta present BUT fingerprint missing / mismatching, or
 *             fingerprints.json has no entry for the file
 *
 * Cascade invalidation (`cascadeStaleSubdir`): given a subdir path,
 * scans every cached explanation, extracts the source file from its
 * `target_node_id`, and reports which files + which symbols are stale
 * — used by the UI to drop the ✦ "explanation available" badge from
 * affected nodes when the user re-indexes (or hot-edits) sources.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Fingerprints } from "../repo-graph/types";
import { cacheKey, explanationDir, explanationPaths, readExplanation } from "./store";
import type { ExplanationMeta } from "./types";

export enum CacheState {
  NoCache = "NoCache",
  Cached = "Cached",
  Stale = "Stale",
}

export interface CacheStateResult {
  state: CacheState;
  /** Plain-language reason populated for Stale; null for NoCache + Cached. */
  reason: string | null;
}

export interface CascadeResult {
  /** Distinct file paths whose cache entry was invalidated. */
  invalidatedFiles: string[];
  /** target_node_id of every symbol-level cache entry invalidated. */
  invalidatedSymbols: string[];
}

const NODE_ID_FILE_RE = /^[^:]+:([^:]+):/;

/**
 * Extract the source file path embedded in a `target_node_id`.
 * Examples:
 *   file:src/cli/doctor.ts:                  → src/cli/doctor.ts
 *   function:src/cli/doctor.ts:runDoctor     → src/cli/doctor.ts
 */
function fileFromNodeId(nodeId: string): string | null {
  const m = NODE_ID_FILE_RE.exec(nodeId);
  return m ? m[1]! : null;
}

export async function deriveCacheState(
  targetNodeId: string,
  cwd: string,
  currentFingerprints: Fingerprints,
): Promise<CacheStateResult> {
  const key = cacheKey(targetNodeId);
  const { metaPath } = explanationPaths(cwd, key);
  if (!existsSync(metaPath)) {
    return { state: CacheState.NoCache, reason: null };
  }
  const cached = await readExplanation(cwd, key);
  if (!cached) {
    return { state: CacheState.NoCache, reason: null };
  }
  return classifyAgainstFingerprints(cached.meta, currentFingerprints);
}

function classifyAgainstFingerprints(
  meta: ExplanationMeta,
  fingerprints: Fingerprints,
): CacheStateResult {
  if (meta.source_fingerprint === undefined) {
    return {
      state: CacheState.Stale,
      reason: "cache predates fingerprint tracking",
    };
  }
  const file = fileFromNodeId(meta.target_node_id);
  if (!file) {
    return {
      state: CacheState.Stale,
      reason: "could not resolve file from target_node_id",
    };
  }
  const currentEntry = fingerprints.files[file];
  if (!currentEntry) {
    return {
      state: CacheState.Stale,
      reason: "source file not tracked in current fingerprints",
    };
  }
  if (currentEntry.content_sha256 !== meta.source_fingerprint) {
    return {
      state: CacheState.Stale,
      reason: "source file changed since cache",
    };
  }
  return { state: CacheState.Cached, reason: null };
}

export async function cascadeStaleSubdir(
  subdirPath: string,
  cwd: string,
  currentFingerprints: Fingerprints,
): Promise<CascadeResult> {
  // Normalize subdir to have a trailing slash so prefix matching is
  // exact-boundary (src/cli/ does NOT match src/clip/foo.ts).
  const subdir = subdirPath.endsWith("/") ? subdirPath : `${subdirPath}/`;

  const dir = explanationDir(cwd);
  if (!existsSync(dir)) {
    return { invalidatedFiles: [], invalidatedSymbols: [] };
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { invalidatedFiles: [], invalidatedSymbols: [] };
  }

  const filesSet = new Set<string>();
  const symbols: string[] = [];

  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const key = name.slice(0, -".meta.json".length);
    const cached = await readExplanation(cwd, key);
    if (!cached) continue;
    const file = fileFromNodeId(cached.meta.target_node_id);
    if (!file || !file.startsWith(subdir)) continue;
    const classification = classifyAgainstFingerprints(cached.meta, currentFingerprints);
    if (classification.state === CacheState.Stale) {
      filesSet.add(file);
      symbols.push(cached.meta.target_node_id);
    }
  }

  return {
    invalidatedFiles: [...filesSet],
    invalidatedSymbols: symbols,
  };
}
