// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `attachWhy` — slice ④ task 6. Maps each changed-file delta from the
 * "since you last looked" watermark panel to a `WhyAnchor` (rung "U"/1/2/3,
 * see `../../repo-graph/why-lookup`), so the panel can show WHY a file
 * changed alongside the existing WHAT-changed classification.
 *
 * Per-row isolation is the whole point of this module: `lookupWhy` does its
 * own git-blame + transcript I/O per file, and a single bad row (corrupt
 * transcript, git blame failure on an unusual path, …) must never sink the
 * rest of the panel. Each row's lookup is wrapped in its own try/catch and
 * degraded to rung 3 (`anchor_scope: "none"`) on throw — same "no WHY
 * recorded" honest-degrade state `lookupWhy` itself uses internally, just
 * applied at the attach layer too so a throw from a custom `deps.lookup`
 * override (as tests exercise) degrades identically to one from the real
 * `lookupWhy`.
 */
import { lookupWhy, type WhyAnchor } from "../../repo-graph/why-lookup";

/**
 * A delta-shaped object carrying (at minimum) the changed file's path. No
 * index signature on purpose — `SeenFileDelta` (the real caller's shape)
 * has none either, and TS won't structurally assign a concrete interface
 * to an indexed type without a cast; the `T extends { path: string }`
 * constraint itself already accepts any object with extra properties.
 */
export interface DeltaWithPath {
  path: string;
}

export interface AttachWhyDeps {
  /** Repo root — passed through to `lookupWhy`/`lookup` as `cwd`. */
  cwd: string;
  /** Task 8 line-range refinement: the user's seen-watermark baseline sha,
   *  passed through to `lookupWhy` so it blames only the lines changed
   *  since that baseline instead of the whole file. Absent (no prior
   *  watermark) ⇒ `lookupWhy`'s existing whole-file fallback. */
  baselineSha?: string;
  /** Override lookup (tests). Defaults to `lookupWhy({ cwd, file, baselineSha })`. */
  lookup?: (cwd: string, file: string) => Promise<WhyAnchor>;
}

const DEGRADED: WhyAnchor = { rung: 3, anchor_scope: "none" };

/**
 * Attach a `why: WhyAnchor` to every delta, resolved in parallel. A throw
 * from any single row's lookup degrades ONLY that row to rung 3 — never
 * rejects the whole `Promise.all`.
 */
export async function attachWhy<T extends DeltaWithPath>(
  deltas: T[],
  deps: AttachWhyDeps,
): Promise<(T & { why: WhyAnchor })[]> {
  const lookup = deps.lookup ?? ((cwd: string, file: string) => lookupWhy({ cwd, file, baselineSha: deps.baselineSha }));
  return Promise.all(
    deltas.map(async (delta) => {
      try {
        const why = await lookup(deps.cwd, delta.path);
        return { ...delta, why };
      } catch {
        return { ...delta, why: DEGRADED };
      }
    }),
  );
}
