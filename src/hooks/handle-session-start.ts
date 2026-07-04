// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * SessionStart hook handler.
 *
 * Captures the git HEAD SHA at the moment a Claude Code session begins and
 * writes it to {cwd}/.siltpoke/baseline.json. The Stop hook reads this file
 * first so it always diffs against the commit that was current at session
 * start, not the potentially-advanced HEAD after commits.
 *
 * Flow:
 *   SessionStart event → handleSessionStart({ cwd, session_id })
 *     → git rev-parse HEAD in cwd
 *     → writes {cwd}/.siltpoke/baseline.json { head_sha, session_id, captured_at }
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface SessionStartInput {
  cwd: string;
  session_id: string;
}

export interface SessionBaseline {
  /** Full git HEAD SHA at session start. Null for non-git directories. */
  head_sha: string | null;
  session_id: string;
  captured_at: string;
}

export async function handleSessionStart(input: SessionStartInput): Promise<void> {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: input.cwd, encoding: "utf8" });
  const head_sha = r.status === 0 ? r.stdout.trim() : null;

  const baseline: SessionBaseline = {
    head_sha,
    session_id: input.session_id,
    captured_at: new Date().toISOString(),
  };

  const dir = join(input.cwd, ".siltpoke");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "baseline.json"), JSON.stringify(baseline, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point for use as a Claude Code hook (stdin JSON event)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(stdin || "{}");
  } catch {
    // malformed stdin — proceed with empty event
  }
  await handleSessionStart({
    cwd: typeof event.cwd === "string" ? event.cwd : process.cwd(),
    session_id: typeof event.session_id === "string" ? event.session_id : "unknown",
  });
}
