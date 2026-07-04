// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Git status snapshot helper for Bash diff detection.
 * Spec anchor: PQ3 — Bash diff detection heuristic (hybrid whitelist ∪ git status snapshot).
 *
 * Captures a baseline of `git status --porcelain=v1 --ignored=traditional -z` at a point
 * in time, then computes the diff between the baseline and any later snapshot to surface
 * which files changed during a session (e.g. between a Stop event baseline and the
 * current working tree state).
 */

import { existsSync } from "node:fs";
import { spawnWithTimeout } from "../critic/spawn";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GitBaseline = {
  cwd: string;
  capturedAt: number; // ms epoch
  /** Map of relative-path → status code (e.g. "M ", " M", "??", "R "). */
  entries: Map<string, string>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * Lockfile names that are allowlisted even when git marks them as ignored.
 * Only matched at root (no parent directory component).
 */
const ROOT_LOCKFILES = new Set([
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true for paths that are gitignored but still relevant for diff detection.
 * - `.env*` files at any depth
 * - Primary lockfiles at repo root only
 */
function isIgnoredButRelevant(path: string): boolean {
  // .env files at any depth (e.g. .env, .env.local, .env.production)
  if (/(^|\/)\.env(\.|$)/.test(path)) return true;
  // Primary lockfiles — root only (no slash in path)
  const base = path.split("/").pop() ?? "";
  if (ROOT_LOCKFILES.has(base)) {
    return path.indexOf("/") === -1; // root only
  }
  return false;
}

/**
 * Parse the NUL-delimited output of `git status --porcelain=v1 --ignored=traditional -z`.
 *
 * With `-z`, each entry is NUL-terminated. The format per entry is:
 *   "XY <path>\0"
 * For renames/copies the entry is two NUL-terminated paths:
 *   "R  <newPath>\0<oldPath>\0"
 * (git porcelain v1 puts the new path in the first field for renames)
 *
 * We return a Map<path, statusCode> where statusCode is the two-char XY prefix.
 * For renames, BOTH old and new paths are stored — old path with status "R " and
 * new path also stored with the raw status code so callers can emit both.
 */
function parsePorcelainV1Z(stdout: string): Map<string, string> {
  const entries = new Map<string, string>();

  if (!stdout) return entries;

  // Split on NUL bytes; the last element after split is typically empty
  const parts = stdout.split("\0");

  let i = 0;
  while (i < parts.length) {
    const raw = parts[i]!;
    if (raw === "") {
      i++;
      continue;
    }

    // Each entry: "XY path" — first two chars are status code, char 3 is a space, rest is path
    if (raw.length < 4) {
      i++;
      continue;
    }

    const xy = raw.slice(0, 2);
    const path = raw.slice(3); // skip "XY "

    const isRename = xy[0] === "R" || xy[0] === "C";

    if (isRename) {
      // For renames in porcelain v1 -z format:
      // parts[i] = "R  <newPath>"
      // parts[i+1] = "<oldPath>"
      const newPath = path;
      const oldPath = parts[i + 1] ?? "";
      if (newPath) entries.set(newPath, xy);
      if (oldPath && oldPath !== "") entries.set(oldPath, "R "); // old path: renamed-away
      i += 2; // consume both parts
    } else {
      entries.set(path, xy);
      i++;
    }
  }

  return entries;
}

/**
 * Run `git -C <cwd> status --porcelain=v1 --ignored=traditional -z`.
 * Returns null on any failure (non-git dir, git not on PATH, timeout, etc.).
 */
async function runGitStatus(cwd: string): Promise<Map<string, string> | null> {
  const result = await spawnWithTimeout({
    argv: [
      "git",
      "-C",
      cwd,
      "status",
      "--porcelain=v1",
      "--ignored=traditional",
      "-z",
    ],
    cwd,
    timeoutMs: GIT_SNAPSHOT_TIMEOUT_MS,
  });

  if (result.timedOut || result.exitCode !== 0) {
    return null;
  }

  return parsePorcelainV1Z(result.stdout);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture a baseline snapshot of `git status --porcelain=v1 --ignored=traditional -z`
 * against the given cwd.
 *
 * Returns null when:
 * - cwd doesn't exist or isn't readable
 * - cwd is not a git repository (or no nearest-ancestor .git/)
 * - git binary is not on PATH (ENOENT)
 * - any other git invocation failure
 */
export async function captureGitBaseline(cwd: string): Promise<GitBaseline | null> {
  // Quick guard: cwd must exist
  if (!existsSync(cwd)) return null;

  // Probe for .git directory — use git rev-parse for correctness across worktrees
  const revParseResult = await spawnWithTimeout({
    argv: ["git", "-C", cwd, "rev-parse", "--git-dir"],
    cwd,
    timeoutMs: GIT_SNAPSHOT_TIMEOUT_MS,
  });

  if (revParseResult.exitCode !== 0 || revParseResult.timedOut) {
    return null;
  }

  const entries = await runGitStatus(cwd);
  if (entries === null) return null;

  return {
    cwd,
    capturedAt: Date.now(),
    entries,
  };
}

/**
 * Compute the set of files that changed between `baseline` and the current
 * `git status --porcelain` snapshot of `cwd`.
 *
 * Returns the union of:
 * - files that appear in current status but NOT in baseline (new dirtiness)
 * - files that appear in BOTH with different status codes (changed status)
 * - files that appear in baseline but NOT in current (got cleaned)
 *
 * Returns relative paths (as reported by git status). Rename entries (`R `)
 * emit BOTH paths. Returns [] if cwd is not a git repo or any failure.
 *
 * Filters: excludes paths with status `!!` (ignored) UNLESS `isIgnoredButRelevant` returns true.
 */
export async function diffAgainstBaseline(
  baseline: GitBaseline,
  cwd: string,
): Promise<string[]> {
  const current = await captureGitBaseline(cwd);
  if (current === null) return [];

  const changed = new Set<string>();

  // Files in current but not in baseline, OR in both with different status code
  for (const [path, statusCode] of current.entries) {
    // Filter ignored files (status "!!" = ignored by git)
    if (statusCode === "!!" && !isIgnoredButRelevant(path)) continue;

    const baselineCode = baseline.entries.get(path);
    if (baselineCode === undefined || baselineCode !== statusCode) {
      changed.add(path);
    }
  }

  // Files in baseline but NOT in current (got cleaned)
  for (const [path, statusCode] of baseline.entries) {
    // Filter ignored files from baseline too
    if (statusCode === "!!" && !isIgnoredButRelevant(path)) continue;

    if (!current.entries.has(path)) {
      changed.add(path);
    }
  }

  return [...changed].sort();
}
