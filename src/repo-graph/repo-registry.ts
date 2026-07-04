// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Repo registry enumeration.
 *
 * Lists every project under `~/.siltpoke/repo-memory/<proj_hash>/` and
 * derives a status per entry for the dashboard's multi-repo picker:
 *
 *   indexing    — meta.json `building: true` (build in flight)
 *   ready       — meta.json present + non-empty last_indexed_ts + not building
 *   not-indexed — meta.json missing, malformed, or never completed a build
 *
 * Backward-compat: missing `building` field is treated as `false`; older
 * entries still resolve to "ready" cleanly.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { siltpokeRoot } from "../installer/paths";

export type RepoStatus = "ready" | "indexing" | "not-indexed";

/**
 * A proj_hash is exactly sha256(project_root)[:12] = 12 lowercase hex chars.
 * Anything else (uppercase, wrong length, traversal like `../x`, sibling names
 * like `summaries`) is not a valid repo id and MUST be refused before any
 * path-join — otherwise a user-supplied id could escape `repo-memory/`.
 */
const PROJ_HASH_RE = /^[0-9a-f]{12}$/;

export function isValidProjHash(s: string): boolean {
  return PROJ_HASH_RE.test(s);
}

export interface RepoEntry {
  /** Directory name under `repo-memory/` (sha256(project_root)[:12]). */
  proj_hash: string;
  /** Absolute project root recorded at last build; null when meta missing. */
  project_root: string | null;
  /** ISO 8601 of last successful build; null when never completed. */
  last_indexed_ts: string | null;
  status: RepoStatus;
}

interface MaybeMeta {
  schemaVersion?: unknown;
  project_root?: unknown;
  last_indexed_ts?: unknown;
  building?: unknown;
}

function deriveStatus(meta: MaybeMeta | null): RepoStatus {
  if (meta === null) return "not-indexed";
  if (meta.building === true) return "indexing";
  const ts = meta.last_indexed_ts;
  if (typeof ts === "string" && ts.length > 0) return "ready";
  return "not-indexed";
}

async function readMetaTolerant(path: string): Promise<MaybeMeta | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as MaybeMeta;
  } catch {
    return null;
  }
}

export interface RepoLocationByHash {
  proj_hash: string;
  /** `~/.siltpoke/repo-memory/<proj_hash>/`. */
  storage_dir: string;
  /** Absolute project root from meta.json; null when meta missing/malformed. */
  project_root: string | null;
}

/**
 * Resolve a repo's storage dir + project root by its proj_hash (the picker's
 * stable key). Returns null when no such storage dir exists. Used by the
 * multi-repo routes where the active repo is chosen by id, not cwd.
 */
export async function resolveRepoByHash(
  projHash: string,
  opts: { home?: string } = {},
): Promise<RepoLocationByHash | null> {
  // Validate the hash shape BEFORE joining, so a malformed id
  // (`../../`, `summaries`, …) can never path-traverse out of repo-memory/.
  if (!isValidProjHash(projHash)) return null;
  const home = opts.home ?? siltpokeRoot();
  const storage_dir = join(home, "repo-memory", projHash);
  if (!existsSync(storage_dir)) return null;
  const meta = await readMetaTolerant(join(storage_dir, "meta.json"));
  return {
    proj_hash: projHash,
    storage_dir,
    project_root: typeof meta?.project_root === "string" ? meta.project_root : null,
  };
}

export async function enumerateRepos(opts: { home?: string } = {}): Promise<RepoEntry[]> {
  const home = opts.home ?? siltpokeRoot();
  const root = join(home, "repo-memory");
  if (!existsSync(root)) return [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  // proj_hash format filter (shared isValidProjHash) so siblings like
  // `summaries/` (from the older repo-memory summarizer) don't surface as fake repos.
  const entries: RepoEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (!isValidProjHash(name)) continue;
    const entryPath = join(root, name);
    let isDir = false;
    try {
      isDir = (await stat(entryPath)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const meta = await readMetaTolerant(join(entryPath, "meta.json"));
    entries.push({
      proj_hash: name,
      project_root: typeof meta?.project_root === "string" ? meta.project_root : null,
      last_indexed_ts:
        typeof meta?.last_indexed_ts === "string" && meta.last_indexed_ts.length > 0
          ? meta.last_indexed_ts
          : null,
      status: deriveStatus(meta),
    });
  }
  // Deterministic order — the SINGLE comparator shared by every consumer (the
  // picker dropdown, the SSR default-repo fallback, the JSON /repos list).
  // Raw readdir order is arbitrary AND unstable across forget/re-index, which
  // would let "fall back to repos[0]" land on a different repo than the list
  // top the user actually sees. Recency-first; never-indexed last; hash ties.
  entries.sort((a, b) => {
    if (a.last_indexed_ts !== b.last_indexed_ts) {
      if (a.last_indexed_ts === null) return 1;
      if (b.last_indexed_ts === null) return -1;
      return a.last_indexed_ts < b.last_indexed_ts ? 1 : -1;
    }
    return a.proj_hash < b.proj_hash ? -1 : a.proj_hash > b.proj_hash ? 1 : 0;
  });
  return entries;
}

/**
 * Delete a repo's on-disk index (`~/.siltpoke/repo-memory/<proj_hash>/`).
 * The shared "forget" primitive — used by the repo-delete route
 * (DELETE /repos/:hash) AND by the index-build's failure/cancel cleanup
 * (a build that ended without flipping `building:false`
 * leaves a partial dir that must be removed). Returns true iff a dir was
 * removed; false for an invalid hash (refused — never touches anything outside
 * `repo-memory/<hash>/`) or a dir that wasn't there (idempotent).
 */
export async function removeRepoIndex(
  projHash: string,
  opts: { home?: string; purge?: boolean } = {},
): Promise<boolean> {
  // Validate BEFORE join — `rm -rf` on a computed path is the scariest line in
  // the change; the only thing standing between it and `rm -rf ../../` is this.
  if (!isValidProjHash(projHash)) return false;
  const home = opts.home ?? siltpokeRoot();
  const storage_dir = join(home, "repo-memory", projHash);
  if (opts.purge) {
    // Explicit purge: everything goes, preserved artifacts included.
    const had = existsSync(storage_dir);
    await rm(storage_dir, { recursive: true, force: true });
    await rm(preservedDir(home, projHash), { recursive: true, force: true });
    return had;
  }
  if (!existsSync(storage_dir)) return false;
  // The index files are $0-regenerable; the arch-model is a PAID LLM artifact
  // ($0.3-1.5/generation — forget once burned ~$1 of it). Move it aside before
  // the rm; the next successful index restores it (restorePreservedArchModel)
  // and readArchModel's fingerprint check classifies it fresh/stale honestly.
  // `.preserved` starts with a dot → enumerateRepos skips it: no picker ghost.
  const stash = preservedDir(home, projHash);
  for (const f of PRESERVED_ARCH_FILES) {
    const src = join(storage_dir, f);
    if (!existsSync(src)) continue;
    await mkdir(stash, { recursive: true });
    await rename(src, join(stash, f));
  }
  await rm(storage_dir, { recursive: true, force: true });
  return true;
}

/** Paid arch-model artifacts spared by a non-purge forget. */
const PRESERVED_ARCH_FILES = ["arch-model.json", "arch-model.meta.json"] as const;

function preservedDir(home: string, projHash: string): string {
  return join(home, "repo-memory", ".preserved", projHash);
}

/**
 * Move a previously preserved arch-model back into a (re-)indexed repo's
 * storage dir. Call after a SUCCESSFUL index build. Returns true when files
 * were restored; false when nothing was preserved or the storage dir doesn't
 * exist (preserved files stay put — never dropped on a failed restore).
 */
export async function restorePreservedArchModel(
  projHash: string,
  opts: { home?: string } = {},
): Promise<boolean> {
  if (!isValidProjHash(projHash)) return false;
  const home = opts.home ?? siltpokeRoot();
  const storage_dir = join(home, "repo-memory", projHash);
  const stash = preservedDir(home, projHash);
  if (!existsSync(stash) || !existsSync(storage_dir)) return false;
  let anyMoved = false;
  let anySkipped = false;
  for (const f of PRESERVED_ARCH_FILES) {
    const src = join(stash, f);
    if (!existsSync(src)) continue;
    const dest = join(storage_dir, f);
    if (existsSync(dest)) {
      anySkipped = true; // a newer paid model is already in place — never clobber it
      continue;
    }
    await rename(src, dest);
    anyMoved = true;
  }
  // Clean the stash only when fully drained: rm-ing after a partial restore
  // would silently delete the skipped (never-moved) file — paid-artifact loss.
  if (anyMoved && !anySkipped) await rm(stash, { recursive: true, force: true });
  return anyMoved;
}
