// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Validate a user-supplied filesystem path before it becomes the
 * `cwd` of a spawned indexer. This is the security core of the in-dashboard
 * index trigger: the endpoint is reachable from a browser on 127.0.0.1:9876, so
 * the path is untrusted and must be canonicalized + contained before any spawn.
 *
 * The chain: trim → absolute → resolve → realpathSync
 * (collapses `..`, resolves symlinks to their real target) → exists + is a
 * directory → contained within an allow-root (and not the root itself). proj_hash
 * is computed from the CANONICAL real path so `/p`, `/p/`, and a symlink to `/p`
 * all dedupe to one repo.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { computeProjHash } from "./proj-hash";

export type IndexPathReject =
  | "empty"
  | "not_absolute"
  | "not_found"
  | "not_a_directory"
  | "outside_allow_root"
  | "unreadable";

export type IndexPathResult =
  | { ok: true; realPath: string; projHash: string }
  | { ok: false; reason: IndexPathReject };

/**
 * Canonicalize `root` (resolve symlinks) and test whether `realPath` lives
 * strictly INSIDE it. The root itself is intentionally rejected: indexing an
 * allow-root verbatim (e.g. all of `$HOME`) is too broad. A root that doesn't
 * exist / can't be realpath'd is skipped, not fatal.
 *
 * EMPTY `allowRoots` → zero iterations → returns false → everything rejected
 * (safe-fail). Callers MUST pass `resolveAllowRoots(cfg)` (which substitutes
 * `[$HOME]` for an empty config), never the raw `cfg.allowRoots` — empty here
 * means "deny all", NOT "allow all".
 *
 * `startsWith(realRoot + sep)` (not bare `startsWith(realRoot)`) is deliberate:
 * it blocks the prefix-collision escape where allowRoot `/home/foo` would
 * otherwise admit `/home/foobar`. `resolve()` strips trailing separators so
 * `realRoot` never ends in `sep` on POSIX.
 */
export function isContainedInAllowRoots(
  realPath: string,
  allowRoots: readonly string[],
  opts: { allowRootItself?: boolean } = {},
): boolean {
  for (const root of allowRoots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(resolve(root));
    } catch {
      continue; // unresolvable allow-root → skip, don't crash
    }
    // Indexing rejects the root itself (too broad); listing (allowRootItself)
    // ALLOWS it — the folder browser starts at + must list `$HOME`.
    if (realPath === realRoot) {
      if (opts.allowRootItself) return true;
      continue;
    }
    if (realPath.startsWith(realRoot + sep)) return true;
  }
  return false;
}

/**
 * Shared canonicalize step (trim → absolute → resolve → realpathSync → isDir),
 * with no containment opinion. Both `validateIndexPath` and `validateListDir`
 * build on this so there is exactly ONE place that turns untrusted input into a
 * canonical real directory path.
 */
function canonicalizeDir(input: string): { ok: true; realPath: string } | { ok: false; reason: IndexPathReject } {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (!isAbsolute(raw)) return { ok: false, reason: "not_absolute" };
  let realPath: string;
  try {
    realPath = realpathSync(resolve(raw));
  } catch {
    return { ok: false, reason: "not_found" };
  }
  let isDir: boolean;
  try {
    isDir = statSync(realPath).isDirectory();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!isDir) return { ok: false, reason: "not_a_directory" };
  return { ok: true, realPath };
}

/**
 * Folder browser: validate a directory the user wants to LIST. Same
 * canonicalize + containment as `validateIndexPath`, but the allow-root itself
 * is listable (you browse from `$HOME` down). No `proj_hash` — listing isn't
 * indexing.
 */
export function validateListDir(
  input: string,
  opts: { allowRoots: readonly string[] },
): { ok: true; realPath: string } | { ok: false; reason: IndexPathReject } {
  const c = canonicalizeDir(input);
  if (!c.ok) return c;
  if (!isContainedInAllowRoots(c.realPath, opts.allowRoots, { allowRootItself: true })) {
    return { ok: false, reason: "outside_allow_root" };
  }
  return { ok: true, realPath: c.realPath };
}

export function validateIndexPath(
  input: string,
  opts: { allowRoots: readonly string[] },
): IndexPathResult {
  // Shared canonicalize (trim → absolute → resolve → realpathSync → isDir).
  // realpathSync resolves symlinks to the real target + throws on missing, so a
  // symlink escape is unmasked before the containment check below.
  const c = canonicalizeDir(input);
  if (!c.ok) return c;
  const { realPath } = c;

  // Containment runs on the REAL path, so a symlink whose target escapes the
  // allow-root is rejected here. Indexing rejects the root itself (too broad).
  if (!isContainedInAllowRoots(realPath, opts.allowRoots)) {
    return { ok: false, reason: "outside_allow_root" };
  }

  // TOCTOU note: `realPath` is canonical AT VALIDATION TIME. There
  // is a narrow window before the caller spawns with it as cwd in which a local
  // attacker with write access could swap the dir for a symlink. The caller
  // (the indexing endpoint) MUST (a) require the daemon secret so only the authed user can
  // trigger this, and (b) pass THIS `realPath` (not the raw input) to the spawn.
  return { ok: true, realPath, projHash: computeProjHash(realPath) };
}
