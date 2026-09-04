// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Index staleness — how far the persisted repo-graph has drifted from what is
 * actually on disk.
 *
 * The oracle is free: `fingerprints.json` already stores a content sha per
 * indexed file, so comparing it against a fresh walk needs no labels, no model
 * call, and no extra bookkeeping at index time. It answers the question the
 * index could not previously answer at all — "is what I'm about to query even
 * current?" — which is why the live index sat 25.3% stale unnoticed.
 *
 * Three DIFFERENT kinds of drift, deliberately reported separately rather than
 * summed into one number:
 *   - `content_changed`  — indexed, still present, but edited since. Re-parsing fixes it.
 *   - `deleted_still_indexed` — indexed, gone from disk. Nothing to re-parse; the row is simply wrong.
 *   - `unindexed_files`  — on disk, never indexed. Not stale data, MISSING data —
 *     invisible to any check that only walks what the index already knows about.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { computeContentSha } from "./fingerprint";
import { resolveRepoGraphLocation } from "./proj-hash";
import { readFingerprints } from "./store";
import type { Fingerprints } from "./types";
import { walkProject } from "./walker";

/** The fields of a stored fingerprint this module needs. */
export interface StalenessFingerprint {
  content_sha256: string;
}

/** A file as seen on disk right now. */
export interface StalenessFile {
  relPath: string;
  contentSha: string;
}

export interface IndexStaleness {
  /** Files present in the index. */
  indexed: number;
  /** Indexed files whose on-disk content still matches. */
  unchanged: number;
  /** Indexed files still present but edited since indexing. */
  content_changed: number;
  /** Indexed files that no longer exist on disk. */
  deleted_still_indexed: number;
  /** Files on disk that the index has never seen. */
  unindexed_files: number;
  /**
   * Indexed files that exist but could not be read during the comparison
   * (permissions, a lock, any transient I/O failure). They are EXCLUDED from
   * every other count rather than folded into `deleted_still_indexed`: "I
   * could not see it" is not "it is gone", and treating the two as the same
   * is precisely the reasoning that let chat search prune live sessions
   * (fixed in #360). A non-zero value here means the other numbers describe
   * fewer files than the index holds.
   */
  read_errors: number;
  /**
   * `content_changed / indexed`, in [0, 1] — the share of indexed rows whose
   * file still exists but has been edited. NAMED NARROWLY ON PURPOSE: it
   * cannot see deletions, so an index consisting entirely of ghost rows for
   * deleted files reads 0 here. Use `rows_wrong_pct` for "how much of this
   * index is wrong". 0 when the index is empty.
   */
  content_stale_pct: number;
  /**
   * `(content_changed + deleted_still_indexed) / indexed`, in [0, 1] — the
   * share of indexed rows that no longer describe reality, for either reason.
   * This is the number a staleness threshold should gate on; `content_stale_pct`
   * alone silently ignores the entire deleted-rows class. Never-indexed files
   * are still excluded, since they are not rows in the index at all — they are
   * reported by `unindexed_files`.
   */
  rows_wrong_pct: number;
}

export function computeStaleness(
  indexed: Readonly<Record<string, StalenessFingerprint>>,
  current: readonly StalenessFile[],
  /** Paths that exist but could not be read — excluded, never assumed deleted. */
  unreadable: readonly string[] = [],
): IndexStaleness {
  // macOS hands out NFD from the filesystem while git and most editors write
  // NFC. Comparing raw strings would turn one untouched file into TWO reported
  // problems — a phantom deletion plus a phantom never-indexed file — so both
  // sides are normalized to one form before any comparison.
  // KNOWN LIMIT: case-only differences (`Foo.ts` vs `foo.ts`) still double-count
  // on case-insensitive filesystems; folding case correctly depends on the
  // target filesystem and is deliberately left for a follow-up.
  const key = (p: string) => p.normalize("NFC");
  const onDisk = new Map(current.map((f) => [key(f.relPath), f.contentSha]));
  const indexedKeys = new Set(Object.keys(indexed).map(key));
  const unreadableKeys = new Set(unreadable.map(key));

  let unchanged = 0;
  let contentChanged = 0;
  let deletedStillIndexed = 0;

  let readErrors = 0;
  for (const [relPath, fingerprint] of Object.entries(indexed)) {
    if (unreadableKeys.has(key(relPath))) {
      readErrors += 1;
      continue;
    }
    const diskSha = onDisk.get(key(relPath));
    if (diskSha === undefined) {
      deletedStillIndexed += 1;
    } else if (diskSha === fingerprint.content_sha256) {
      unchanged += 1;
    } else {
      contentChanged += 1;
    }
  }

  // No unreadable-file guard here on purpose: a file that failed to read is
  // never pushed into `current`, so it cannot reach this loop. A guard would
  // read as defensive and do nothing — mutation-proven (deleting it failed no
  // test), which is this repo's definition of decoration.
  let unindexedFiles = 0;
  for (const file of current) {
    if (!indexedKeys.has(key(file.relPath))) unindexedFiles += 1;
  }

  const indexedCount = Object.keys(indexed).length;
  // An empty index would otherwise divide by zero and yield NaN, which renders
  // as "NaN%" and compares false against every threshold — silently passing any
  // staleness gate built on it.
  const contentStalePct = indexedCount === 0 ? 0 : contentChanged / indexedCount;
  const rowsWrongPct = indexedCount === 0 ? 0 : (contentChanged + deletedStillIndexed) / indexedCount;

  return {
    indexed: indexedCount,
    unchanged,
    content_changed: contentChanged,
    deleted_still_indexed: deletedStillIndexed,
    unindexed_files: unindexedFiles,
    read_errors: readErrors,
    content_stale_pct: contentStalePct,
    rows_wrong_pct: rowsWrongPct,
  };
}

/**
 * Compute staleness for a real project by reading its stored fingerprints and
 * re-hashing what is on disk now. Returns `null` when the project has no index
 * — deliberately distinct from an index that is present and perfectly fresh,
 * which reports 0 everywhere and would otherwise be indistinguishable.
 *
 * Costs one walk + one sha per file (no parsing) — ~1s on a 600-file repo,
 * which is why this can run as a routine health check rather than a build.
 */
export async function readIndexStaleness(opts: {
  cwd: string;
  home?: string;
  /** Seam for tests; defaults to reading the real file. */
  readFileFn?: (absPath: string) => Promise<string>;
}): Promise<IndexStaleness | null> {
  const read = opts.readFileFn ?? ((p: string) => readFile(p, "utf8"));
  const { project_root, storage_dir } = resolveRepoGraphLocation(opts.cwd, { home: opts.home });
  let root = project_root;
  let fingerprints: Fingerprints = await readFingerprints(storage_dir);
  // resolveRepoGraphLocation intentionally does NOT canonicalize: two callers
  // that pass the identical raw cwd string must keep hashing to the identical
  // storage_dir (existing behavior every other test here depends on). But a raw
  // cwd can differ in symlink form from the one used at build time — macOS
  // `/var` vs `/private/var`, or a repo reached through a dev symlink — and
  // resolveProjectRoot's marker-less fallback returns cwd verbatim, so the raw
  // lookup above finds nothing even though the SAME physical repo is indexed.
  // Root realpath-canonicalization is therefore MANDATORY here, unconditionally
  // (spec §6/R15) — not gated behind a flag or only attempted "if the raw
  // lookup looks suspicious": it always runs the moment the raw/primary lookup
  // comes up empty, before falling back to "never indexed". Wrapped in
  // try/catch — a cwd that cannot be resolved (vanished, permission) keeps the
  // original (empty) result rather than throwing.
  if (Object.keys(fingerprints.files).length === 0) {
    try {
      const canonicalRoot = realpathSync(project_root);
      if (canonicalRoot !== project_root) {
        const canonicalLocation = resolveRepoGraphLocation(canonicalRoot, { home: opts.home });
        const canonicalFingerprints = await readFingerprints(canonicalLocation.storage_dir);
        if (Object.keys(canonicalFingerprints.files).length > 0) {
          root = canonicalRoot;
          fingerprints = canonicalFingerprints;
        }
      }
    } catch {
      // keep the raw (empty) result if realpath cannot resolve the cwd
    }
  }
  // An index that exists but holds zero files is still an index; "no index at
  // all" is what readFingerprints reports as an empty object on a missing file,
  // so the two are separated by whether any file was ever recorded.
  if (Object.keys(fingerprints.files).length === 0) return null;

  const walk = await walkProject(root);
  const current: StalenessFile[] = [];
  const unreadable: string[] = [];
  for (const file of walk.files) {
    let content: string;
    try {
      content = await read(file.absPath);
    } catch {
      // The walk saw it, so it existed a moment ago. It may have vanished
      // since, or the read may have hit a permission error or a lock — those
      // are NOT distinguishable here, so the file is excluded from the
      // comparison and reported as a read error rather than assumed deleted.
      unreadable.push(file.relPath);
      continue;
    }
    current.push({ relPath: file.relPath, contentSha: computeContentSha(content) });
  }

  return computeStaleness(fingerprints.files, current, unreadable);
}
