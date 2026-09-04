// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared availability probes for tests that shell out to `scripts/session_card.py`.
 *
 * The card imports PLC's newest cached `session_card.py` from
 * `~/.claude/plugins/cache/project-life-cycle/project-lifecycle/*\/scripts/session_card.py`
 * and raises when that glob is empty (no python3, or no cached PLC plugin —
 * both true on CI's `ubuntu-latest` unit-test job, neither installed there).
 * Any test that runs the card for real must gate on BOTH checks before
 * asserting on its output, or it either false-fails on a machine without the
 * cache, or (worse) reports its own "card unavailable" error as a test
 * failure instead of an honest skip.
 *
 * Lifted out of `tests/resume/card-render.test.ts` (Self-audit A, 2026-07-23)
 * so `tests/progress/parity-with-plc.test.ts` can reuse the exact same gate
 * instead of a third hand-rolled variant that only checked `existsSync` on
 * the two committed input files (CARD, ROADMAP.md) — both always present in
 * this repo, so that gate was never false, i.e. the test could never skip on
 * a machine that actually lacks python3/the PLC cache. Filename deliberately
 * has NO `.test.ts` suffix (matching `tests/e2e/_setup/*.ts`) so `bun test`'s
 * glob does not pick this up and try to run it as its own suite.
 */
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function plcCachePresent(): boolean {
  try {
    const hits = globSync(
      "project-life-cycle/project-lifecycle/*/scripts/session_card.py",
      { cwd: join(homedir(), ".claude", "plugins", "cache") },
    );
    return hits.length > 0;
  } catch {
    return false;
  }
}

export function pythonPresent(): boolean {
  const r = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}
