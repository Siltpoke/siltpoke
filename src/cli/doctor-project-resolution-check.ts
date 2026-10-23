// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor row: does a live project still resolve, independently of cwd?
 *
 * Its own file, like every other `doctor-*-check.ts`, because defect `[29]`'s
 * fix added the two check registries and their crash guards to `doctor.ts` and
 * pushed it past its length pin. A pin only turns down, so a check that was
 * already the odd one out \u2014 the only one still inline \u2014 moved to where its
 * siblings live. The body below is unchanged.
 */
import { siltpokeRoot } from "../installer/paths";
import { resolveDaemonProject } from "../memory/active-project";
import type { CheckResult, DoctorOptions } from "./doctor";

/**
 * Standing guard for the whole cwd=/ project-resolution bug class (daemon
 * per-request project-resolution track, T13). Runs the same resolver the
 * daemon uses for every request (`resolveDaemonProject`, src/memory/active-
 * project.ts) and asserts a live project resolves, so a silent re-regression
 * becomes a visible doctor row instead of a symptom discovered days later.
 *
 * `resolveDaemonProject` is already cwd-independent (it resolves from
 * ?repo=/pin/recency against the projects store, never `process.cwd()`), so
 * this check does NOT force `process.chdir("/")` — that would mutate the
 * live CLI process's cwd for every check that runs after it (a much bigger
 * side effect than a diagnostic warrants) without adding coverage the
 * resolver's own cwd-independence doesn't already give us. The value here is
 * a STANDING assertion that a live project resolves, not a cwd probe.
 *
 * Async (queries the projects store), so it is NOT folded into the sync
 * `runAllChecks()` array — it runs alongside the other async daemon checks
 * in `runDoctorCli` below, following that same async-check pattern, and
 * (unlike the warn-only daemon rows) DOES affect the exit code: a resolved
 * source with no `project_root` is a genuine fault, not a healthy-empty state.
 */
export async function checkProjectResolutionUnderRoot(
  opts: DoctorOptions,
): Promise<CheckResult> {
  const name = "project resolution survives cwd=/";
  const home = opts.siltpokeHome ?? siltpokeRoot();
  const resolveFn = opts.resolve ?? ((i: { home: string }) => resolveDaemonProject({ home: i.home }));
  const r = await resolveFn({ home });
  if (r.source === "none") {
    // Empty install (no projects registered yet) is not an error — warn only.
    return { name, pass: true, status: "warn", detail: "no active project yet — run a review or open a repo" };
  }
  if (!r.project_root) {
    return { name, pass: false, detail: `resolver returned source=${r.source} but no project_root` };
  }
  return { name, pass: true, detail: null };
}
