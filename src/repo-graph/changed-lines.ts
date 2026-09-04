// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `changedLineRanges` — slice ④ task 8 (line-range refinement, spec §11
 * un-deferred). Parses `git diff --unified=0 <baselineSha>..HEAD -- <file>`
 * hunk headers into CURRENT-file line ranges, so `why-lookup.ts` can blame
 * only the lines that changed since the user's watermark instead of the
 * whole file — bounding staleness to the changed region (a stale older
 * commit elsewhere in the file can no longer surface as the WHY anchor).
 */
import { spawnWithTimeout } from "../critic/spawn";

export interface LineRange { start: number; end: number }
export type RunGit = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>;

const GIT_TIMEOUT_MS = 5000;
const defaultRunGit: RunGit = async (argv, cwd) => {
  const r = await spawnWithTimeout({ argv: ["git", ...argv], cwd, timeoutMs: GIT_TIMEOUT_MS });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout };
};

// Parse `@@ -a,b +c,d @@` — the +c,d side is the current-file range. d
// omitted ⇒ 1; d===0 ⇒ pure deletion, no current-file line to blame.
export async function changedLineRanges(input: {
  cwd: string;
  file: string;
  baselineSha: string;
  runGit?: RunGit;
}): Promise<LineRange[]> {
  const runGit = input.runGit ?? defaultRunGit;
  // `git diff <baselineSha> -- <file>` (NOT `baselineSha..HEAD`) diffs the
  // baseline against the WORKING TREE — its `+`-side line numbers must
  // match what `blameLines` (no rev, also working-tree) blames, or a
  // HEAD-numbered range desyncs against uncommitted edits that shift line
  // counts and points blame at unrelated physical lines (the exact
  // stale-commit bug this task exists to prevent).
  const { exitCode, stdout } = await runGit(
    ["diff", "--unified=0", input.baselineSha, "--", input.file],
    input.cwd,
  );
  if (exitCode !== 0) return [];
  const ranges: LineRange[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue; // pure deletion — no current-file line
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}
