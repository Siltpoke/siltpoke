// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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
 * Resolve where to store the repo-graph for the given cwd. Does NOT
 * create the directory — caller is responsible for `mkdir({recursive})`
 * before writing.
 */
export function resolveRepoGraphLocation(
  cwd: string,
  opts: { home?: string } = {},
): RepoGraphLocation {
  const { project_root } = resolveProjectRoot(cwd);
  const proj_hash = computeProjHash(project_root);
  const home = opts.home ?? siltpokeRoot();
  const storage_dir = join(home, "repo-memory", proj_hash);
  return { project_root, proj_hash, storage_dir };
}
