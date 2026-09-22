// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Derive the per-project repo-graph storage dir from a cwd.
 *
 * Project root resolution reuses `resolveProjectRoot()` from
 * `src/memory/project.ts` (marker file > git root > cwd fallback).
 * The proj-hash is `sha256(project_root)[:12]` — matches the design
 * doc's namespacing scheme.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveProjectRoot } from "../memory/project";
import { siltpokeRoot } from "../installer/paths";

const PROJ_HASH_LEN = 12;

export function computeProjHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, PROJ_HASH_LEN);
}

export interface RepoGraphLocation {
  /** Absolute project root path. */
  project_root: string;
  /** `sha256(project_root)[:12]`. */
  proj_hash: string;
  /** Absolute path to `~/.siltpoke/repo-memory/{proj_hash}/`. */
  storage_dir: string;
}

/**
 * The storage location for an index rooted at exactly `projectRoot` — no
 * walk-up. Used when the root is already known: an explicit `--root`, or a
 * root read back from a stored index's meta. Re-deriving from a stored root via
 * `resolveRepoGraphLocation` would walk a sub-folder up to its repo and land on
 * a different index (spec 2026-09-14 §3.2).
 */
export function repoGraphLocationForRoot(
  projectRoot: string,
  opts: { home?: string } = {},
): RepoGraphLocation {
  const proj_hash = computeProjHash(projectRoot);
  const home = opts.home ?? siltpokeRoot();
  return { project_root: projectRoot, proj_hash, storage_dir: join(home, "repo-memory", proj_hash) };
}

/**
 * Resolve where to store the repo-graph for the given cwd (marker > git root >
 * cwd). Does NOT create the directory — caller is responsible for
 * `mkdir({recursive})` before writing.
 */
export function resolveRepoGraphLocation(
  cwd: string,
  opts: { home?: string } = {},
): RepoGraphLocation {
  return repoGraphLocationForRoot(resolveProjectRoot(cwd).project_root, opts);
}
