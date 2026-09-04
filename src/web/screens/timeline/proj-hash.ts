// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-row proj_hash resolution for the Timeline detail pane's
 * "chat about this review" trigger (task 5).
 *
 * The critique-anchor chat contract (POST /api/chat body.critique_anchor)
 * needs `{ proj_hash, critique_id }`. proj_hash MUST be computed
 * SERVER-SIDE from the critique's `cwd` — the browser has no way to derive
 * it (it doesn't know the critique's original working directory), so this
 * is resolved at SSR time and carried on the button as a data attribute.
 *
 * Never throws: a null/unresolvable cwd yields "" (the backend treats an
 * empty/invalid proj_hash as an unresolvable critique → honest
 * `critique_gone`, never a silent wrong-repo match).
 */

import { resolveProjectRoot } from "../../../memory/project";
import { computeProjHash } from "../../../repo-graph/proj-hash";

export function projHashForCall(cwd: string | null): string {
  if (!cwd) return "";
  try {
    return computeProjHash(resolveProjectRoot(cwd).project_root);
  } catch {
    return "";
  }
}

/**
 * Memoized wrapper (Task 6, carried perf fix from the Task 5 review):
 * `projHashForCall` → `resolveProjectRoot` → a SYNCHRONOUS filesystem walk
 * (readFileSync/statSync up the directory tree). Called once per rendered
 * row inside `TimelineScreen`'s `firedRows.map` with no memoization, that's
 * up to 200 sync dir walks per `/timeline` render — even though rows
 * overwhelmingly share a handful of distinct `cwd` values.
 *
 * Call ONCE per render (e.g. `const resolve = makeProjHashResolver();`
 * before the `.map`) so the cache scope matches the render — never module-
 * level/shared across requests.
 *
 * `resolve` is an injectable seam for tests (defaults to the real
 * `projHashForCall`) so a test can prove invocation counts without touching
 * the filesystem.
 */
export function makeProjHashResolver(
  resolve: (cwd: string | null) => string = projHashForCall,
): (cwd: string | null) => string {
  const cache = new Map<string, string>();
  return (cwd: string | null): string => {
    const key = cwd ?? "";
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = resolve(cwd);
    cache.set(key, result);
    return result;
  };
}
