// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { changedLineRanges } from "../../src/repo-graph/changed-lines";

function fakeGit(stdout: string, capture?: string[][]) {
  return async (argv: string[], _cwd: string) => { capture?.push(argv); return { exitCode: 0, stdout }; };
}

test("parses unified=0 hunk headers into current-file (+) ranges, and uses the right git command", async () => {
  const argvSeen: string[][] = [];
  // `git diff --unified=0 base -- file` (baseline vs WORKING TREE, not HEAD
  // — must line up with blameLines' own working-tree blame) — two hunks:
  // +12,3 and +40,1
  const diff = ["diff --git a/f b/f", "@@ -10,2 +12,3 @@ ctx", "+a", "+b", "+c", "@@ -38 +40 @@", "+x"].join("\n");
  const r = await changedLineRanges({ cwd: "/r", file: "src/f.ts", baselineSha: "base", runGit: fakeGit(diff, argvSeen) });
  expect(r).toEqual([{ start: 12, end: 14 }, { start: 40, end: 40 }]);
  expect(argvSeen[0]).toEqual(["diff", "--unified=0", "base", "--", "src/f.ts"]);
});

test("no changes / git failure ⇒ empty ranges (caller falls back to whole-file)", async () => {
  expect(await changedLineRanges({ cwd: "/r", file: "src/f.ts", baselineSha: "base", runGit: async () => ({ exitCode: 0, stdout: "" }) })).toEqual([]);
  expect(await changedLineRanges({ cwd: "/r", file: "src/f.ts", baselineSha: "base", runGit: async () => ({ exitCode: 128, stdout: "" }) })).toEqual([]);
});

test("pure-deletion hunk (+c,0) contributes no current-file range", async () => {
  const diff = ["@@ -5,3 +4,0 @@", "-gone"].join("\n");
  expect(await changedLineRanges({ cwd: "/r", file: "src/f.ts", baselineSha: "base", runGit: fakeGit(diff) })).toEqual([]);
});
