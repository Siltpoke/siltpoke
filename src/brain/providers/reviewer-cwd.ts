// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

/**
 * Reviewer subprocess cwd (Task 14 — latent hardening). `opts.cwd` is
 * required in practice: every live Stop-hook caller threads
 * `brainContext.cwd` through to the reviewer providers (ccfork-reviewer,
 * codex, agy). Under launchd the daemon's own `process.cwd()` is frozen at
 * `/` (or wherever the daemon was launched from), NOT the repo under
 * review — a caller that omits `opts.cwd` would otherwise silently review
 * the wrong directory with no signal. This is not a live bug today (no
 * caller omits cwd), but the fallback stays as defense-in-depth for
 * direct/manual callers — so it must warn loudly instead of failing
 * silently.
 */
export function resolveReviewerCwd(
  opts: { cwd?: string },
  warn: (m: string) => void = console.warn,
): string {
  if (!opts.cwd) {
    warn(
      "[reviewer] opts.cwd absent — falling back to process.cwd(); review may target the wrong directory",
    );
    return process.cwd();
  }
  return opts.cwd;
}
