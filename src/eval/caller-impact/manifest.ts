// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { sha256 } from "../../repo-memory/cache";

/**
 * A planted-bug location within an example diff, or null for a clean control.
 */
export interface PlantedBug {
  file: string;
  function: string;
  line: number;
}

/**
 * One frozen eval example. `plantedBug === null` (and `isControl === true`)
 * marks a clean control whose only valid score is a false-positive count.
 */
export interface EvalExample {
  id: string;
  repo: string;
  /** Path to a diff fixture on disk, OR an inline diff string. One must be set. */
  diffPath?: string;
  diff?: string;
  plantedBug: PlantedBug | null;
  isControl: boolean;
  /**
   * The signature-changed function whose cross-file callers the arms resolve
   * (the diff is constructed as a signature break of this function). Required
   * for non-control examples; the resolver searches `repo` for its callers.
   */
  changedFunction?: string;
  /**
   * coherent-irrelevant control arm: a DIFFERENT real function (with real
   * callers) whose caller block is injected at equal token budget — coherence
   * without relevance (E-4 confound control). The graph arm must beat THIS.
   */
  wrongTarget?: string;
}

/**
 * The frozen, hashed example set. `contentHash` pins the exact corpus the
 * verdict was computed over; INV2 refuses to run if the live set drifts.
 */
export interface EvalManifest {
  version: string;
  examples: EvalExample[];
  contentHash: string;
}

/**
 * Canonicalize an example to a stable, key-ordered shape so the hash is
 * independent of object key insertion order. Only the load-bearing fields
 * participate — adding a transient field must not silently change the hash,
 * so we whitelist explicitly.
 */
function canonicalExample(ex: EvalExample): unknown {
  const planted =
    ex.plantedBug === null
      ? null
      : {
          file: ex.plantedBug.file,
          function: ex.plantedBug.function,
          line: ex.plantedBug.line,
        };
  // Stable, explicit key order.
  return {
    id: ex.id,
    repo: ex.repo,
    diff: ex.diff ?? null,
    diffPath: ex.diffPath ?? null,
    isControl: ex.isControl,
    plantedBug: planted,
    changedFunction: ex.changedFunction ?? null,
    wrongTarget: ex.wrongTarget ?? null,
  };
}

/**
 * Canonical (stable key order) JSON of the example set → sha256.
 * Examples are sorted by id first so set-order does not affect the hash.
 */
export function computeContentHash(examples: EvalExample[]): string {
  const sorted = [...examples].sort((a, b) => a.id.localeCompare(b.id));
  const canonical = sorted.map(canonicalExample);
  return sha256(JSON.stringify(canonical));
}

/**
 * Build a frozen manifest from examples — the ONLY sanctioned way to compute a
 * `contentHash`. Enforces that every example carries its diff CONTENT inline:
 * `diffPath` is provenance only and is NOT trusted by the hash, so a fixture
 * file mutated on disk would otherwise slip past INV2. Inlining the diff at
 * freeze time makes INV2 pin the actual bytes the verdict was computed over.
 */
export function freezeManifest(
  version: string,
  examples: EvalExample[],
): EvalManifest {
  for (const ex of examples) {
    if (!ex.diff || ex.diff.length === 0) {
      throw new Error(
        `freeze requires inline diff content for example "${ex.id}" — ` +
          `diffPath is provenance only; resolve it to an inline \`diff\` before freezing (INV2 pins diff bytes, not the path string)`,
      );
    }
  }
  return { version, examples, contentHash: computeContentHash(examples) };
}

export interface FreezeGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * INV2: the harness refuses to run if the live example set no longer matches
 * the hash baked into the manifest. Recompute over `liveExamples` and compare.
 */
export function freezeGuard(
  manifest: EvalManifest,
  liveExamples: EvalExample[],
): FreezeGuardResult {
  const liveHash = computeContentHash(liveExamples);
  if (liveHash !== manifest.contentHash) {
    return {
      ok: false,
      reason: `frozen-set drift: manifest hash ${manifest.contentHash} != live hash ${liveHash}`,
    };
  }
  if (manifest.examples.length !== liveExamples.length) {
    return {
      ok: false,
      reason: `example count drift: manifest ${manifest.examples.length} != live ${liveExamples.length}`,
    };
  }
  return { ok: true };
}
