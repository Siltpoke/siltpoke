// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Re-anchor the review cwd to the edited files' repo when a host's Stop
 * payload hands us a cwd that doesn't contain the edits.
 *
 * Motivating case (memory `agy-host-p-mode-cwd-gap`): `agy -p` headless mode
 * omits `workspacePaths`, so `agy-stop.ts` falls back to `process.cwd()` —
 * agy's own config dir (`~/.gemini/config`). The critic then runs its tools
 * (git diff / tsc / ripgrep) against a directory with no diff and abstains
 * ("no tools produced usable output"), even though the transcript recorded a
 * real edit. The changed-file paths in the transcript ARE absolute and
 * correct (extractChangedFiles surfaces them regardless of cwd), so the repo
 * they live in is a better review anchor than the degraded payload cwd.
 *
 * Scoped to `antigravity` — the only host with the degraded-payload cwd gap.
 * Every other host (Claude/codex/codebuddy/qoder) reports a correct cwd, so
 * this returns their payload cwd untouched. Also a no-op for agy when the
 * payload cwd already contains an edited file (interactive mode, where
 * workspacePaths is populated) or when no absolute changed file / git root is
 * found — never worse than the status quo.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

function findGitRoot(startDir: string, exists: (p: string) => boolean): string | undefined {
  let dir = startDir;
  // Bounded walk — defensive against a pathological path with no filesystem root.
  for (let i = 0; i < 64; i++) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function cwdContains(cwd: string, file: string): boolean {
  if (file === cwd) return true;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return file.startsWith(base);
}

export interface ResolveHostCwdOpts {
  host?: string;
  payloadCwd?: string;
  changedFiles: readonly string[];
}

/**
 * Returns the cwd the critic should review in. Pure; `exists` is injectable
 * for tests (defaults to node:fs existsSync).
 */
export function resolveHostCwd(
  opts: ResolveHostCwdOpts,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const { host, payloadCwd, changedFiles } = opts;
  if (host !== "antigravity") return payloadCwd;

  const absChanged = changedFiles.filter((f) => isAbsolute(f));
  const anchor = absChanged[0];
  if (!anchor) return payloadCwd;

  // Payload cwd already contains an edit → trust it (interactive agy).
  if (payloadCwd && absChanged.some((f) => cwdContains(payloadCwd, f))) {
    return payloadCwd;
  }

  // Anchor on the first changed file that actually LIVES IN A REPO, not simply
  // the first one in the list. `unionPaths` sorts, so `absChanged[0]` is the
  // lexicographically smallest path — which for a repo under ~/Projects loses
  // to a `~/.claude/.../memory/*.md` write, and for anything under a tmp root
  // loses to a build log written beside it. Anchoring on such a file walks up
  // to a directory with no `.git`, and the review cwd becomes the noise file's
  // own parent: the critic then reviews the log and not the code.
  for (const f of absChanged) {
    const root = findGitRoot(dirname(f), exists);
    if (root) return root;
  }

  // No changed file is in a repo at all — keep the pre-existing behaviour
  // (the first path's directory) rather than inventing a new failure mode.
  return dirname(anchor);
}
