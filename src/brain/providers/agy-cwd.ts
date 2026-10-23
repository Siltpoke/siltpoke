// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../brain";
import type { BrainFailureInput } from "../failure-classify";

/**
 * The cwd agy is spawned in: a fresh empty temp dir, one per call, never the
 * reviewed repo. Prompt-injection [A], measured 2026-10-21 on agy 1.4.2 with
 * agy.ts's own argv (`--sandbox` included): spawned in a repo, agy obeyed the
 * repo's `GEMINI.md`, `AGENTS.md` and `.agents/skills/`, and RAN the shell
 * commands in its `.agents/hooks.json` (they wrote outside the repo). We found
 * no agy setting that turns this off. Spawned in an empty dir, with the repo
 * path named in the prompt, none of it happened (0 hooks loaded, no code
 * words). Evidence: an internal design note
 * Per call, not one shared dir: anything agy writes into its cwd must not be
 * there for the next call to load.
 */
export function makeAgyCwd(): string {
  try {
    return mkdtempSync(join(tmpdir(), "siltpoke-agy-cwd-"));
  } catch (err) {
    // NOT `spawnError`: agy never ran, and a mkdtemp ENOENT there would read as
    // "binary missing" and latch the breaker as permanent. In `stderr` it
    // classifies as ambiguous (failure-classify.ts).
    throw new BrainError(`agy -p: could not create an empty cwd: ${err}`, err, {
      exitCode: null,
      stderr: `could not create an empty cwd: ${err}`,
      stdout: "",
    } satisfies BrainFailureInput);
  }
}

/** Best-effort removal from `callRaw`'s `finally` — must never affect the call's outcome. */
export function removeAgyCwd(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
