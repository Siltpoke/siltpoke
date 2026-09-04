// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The single containment test: does `file` land inside `cwd`?
 *
 * Accepts a path in either form — absolute (an Edit/Write `tool_use` input) or
 * relative-to-cwd (git status output, a parsed Bash argv) — and returns the
 * RESOLVED ABSOLUTE path when it is inside `cwd`, `null` when it is not.
 * Returning the resolved path rather than a boolean is deliberate: every caller
 * that keeps a path then wants to read it, and `join(cwd, file)` silently
 * mis-resolves an absolute `file` (`join("/repo", "/tmp/x")` → `/repo/tmp/x`).
 *
 * Containment is decided with `relative()`, never `startsWith()` — a sibling
 * directory that merely shares the prefix (`/Users/v/repo-other` against
 * `/Users/v/repo`) is outside, and a string-prefix test calls it inside.
 *
 * An empty `cwd` is rejected rather than defaulted: `resolve("", p)` silently
 * anchors at `process.cwd()`, which in a detached distil worker is not the repo
 * under review.
 */
export function resolveInsideRepo(cwd: string, file: string): string | null {
  try {
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    if (typeof file !== "string" || file.length === 0) return null;
    const base = resolve(cwd);
    const abs = resolve(base, file);
    const rel = relative(base, abs);
    // "" means `file` IS cwd; an absolute rel or a leading `..` SEGMENT means it
    // escaped. Compare segments, not the raw prefix — a legitimate in-repo file
    // named `..hidden` starts with ".." without escaping anything.
    if (isAbsolute(rel)) return null;
    if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
    return abs;
  } catch {
    return null;
  }
}
