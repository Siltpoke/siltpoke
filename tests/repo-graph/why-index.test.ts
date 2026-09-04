// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSessionCommits, readWhyIndex } from "../../src/repo-graph/why-index";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddd";
const SHA_E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
function fakeGit(stdout: string, capture?: string[][]) {
  return async (argv: string[], _cwd: string) => { capture?.push(argv); return { exitCode: 0, stdout }; };
}
const base = { transcriptPath: "/t/x.jsonl", host: "claude-code" as const, baselineSha: "base",
  capturedAt: "2026-07-27T00:00:00.000Z", headSha: "head", stopTime: "2026-07-27T02:00:00.000Z" };

test("records in-window commit keyed by sha under sessions[], and uses git log --no-merges", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-idx-"));
  const argvSeen: string[][] = [];
  await recordSessionCommits({ ...base, cwd, sessionId: "s1", stopTime: "2026-07-27T01:00:00.000Z",
    runGit: fakeGit(`${SHA_A} 2026-07-27T00:30:00.000Z\n`, argvSeen) });
  const idx = await readWhyIndex(cwd);
  expect(idx[SHA_A]?.sessions[0]?.session_id).toBe("s1");
  expect(argvSeen[0]?.slice(0, 2)).toEqual(["log", "--no-merges"]); // not rev-list; --no-merges present
});

test("commit OUTSIDE [captured_at, stop_time] is dropped (git pull / other terminal)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-idx-"));
  await recordSessionCommits({ ...base, cwd, sessionId: "s1", stopTime: "2026-07-27T01:00:00.000Z",
    runGit: fakeGit(`${SHA_B} 2026-07-26T12:00:00.000Z\n`) });
  expect((await readWhyIndex(cwd))[SHA_B]).toBeUndefined();
});

test("two sessions over the same sha APPEND, never clobber", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-idx-"));
  const g = fakeGit(`${SHA_C} 2026-07-27T00:30:00.000Z\n`);
  await recordSessionCommits({ ...base, cwd, sessionId: "s1", runGit: g });
  await recordSessionCommits({ ...base, cwd, sessionId: "s2", runGit: g });
  expect((await readWhyIndex(cwd))[SHA_C]?.sessions.map((s) => s.session_id)).toEqual(["s1", "s2"]);
});

test("readWhyIndex returns {} when no file exists", async () => {
  expect(await readWhyIndex(await mkdtemp(join(tmpdir(), "why-idx-")))).toEqual({});
});

test("write is atomic (tmp-then-rename): no leftover tmp artifact, and a prior entry survives a second write", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "why-idx-"));
  // First write establishes SHA_D under session s1.
  await recordSessionCommits({ ...base, cwd, sessionId: "s1",
    runGit: fakeGit(`${SHA_D} 2026-07-27T00:30:00.000Z\n`) });
  // Second write, a different sha entirely (SHA_E, session s2) — read-merge-write must not
  // clobber SHA_D even though it's a fresh recordSessionCommits call with no knowledge of it
  // beyond what's on disk. If the write path ever regressed to overwrite-from-empty (the
  // corruption scenario a truncated/invalid file would trigger via readWhyIndex's catch-all),
  // SHA_D would vanish here.
  await recordSessionCommits({ ...base, cwd, sessionId: "s2",
    runGit: fakeGit(`${SHA_E} 2026-07-27T00:45:00.000Z\n`) });
  const idx = await readWhyIndex(cwd);
  expect(idx[SHA_D]?.sessions[0]?.session_id).toBe("s1");
  expect(idx[SHA_E]?.sessions[0]?.session_id).toBe("s2");
  // The rename() step must leave no `*.tmp.*` artifact behind — proves the write went
  // through the atomic tmp-then-rename path (not a plain writeFile straight to the target,
  // which is the non-atomic path a mid-write kill can leave truncated/invalid).
  const entries = await readdir(join(cwd, ".siltpoke"));
  expect(entries).toEqual(["why-index.json"]);
  expect(entries.some((f) => f.includes(".tmp."))).toBe(false);
});
