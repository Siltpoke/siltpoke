// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// The one place the "is this path inside the repo?" boundary is decided.
//
// WHY this exists: the changed-file extractor emitted every path the transcript
// mentioned, repo-external ones included. Measured over 125 August critiques in
// this repo, 1264 of 2086 changed_files entries (60%) were outside the repo —
// /tmp build logs, /dev/null, scratchpad scripts, and 141 stale paths under a
// Checkout root the repo had since been moved off. One of those (/tmp/ci-2-signal.log,
// 9915 lines) tripped the god-file rubric and became the critique's anchors[0],
// which the acted-on oracle then failed to read forever.
import { test, expect } from "bun:test";
import { resolveInsideRepo } from "../../src/utils/repo-path";

const CWD = "/Users/v/repo";

test("keeps a cwd-relative path and returns it resolved", () => {
  expect(resolveInsideRepo(CWD, "src/a.ts")).toBe("/Users/v/repo/src/a.ts");
});

test("keeps an absolute path that lands inside cwd", () => {
  // Edit/Write tool_use paths are absolute; they must survive.
  expect(resolveInsideRepo(CWD, "/Users/v/repo/src/a.ts")).toBe("/Users/v/repo/src/a.ts");
});

test("rejects the repo-external absolute paths actually observed in changed_files", () => {
  expect(resolveInsideRepo(CWD, "/tmp/ci-2-signal.log")).toBeNull();
  expect(resolveInsideRepo(CWD, "/dev/null")).toBeNull();
  expect(resolveInsideRepo(CWD, "/private/tmp/claude-501/x/scratchpad/mklabels.py")).toBeNull();
  // A checkout root the repo was moved off of: still shaped like a project
  // Path, still outside cwd.
  expect(resolveInsideRepo(CWD, "/Users/v/old-checkouts/x/docs/notes.md")).toBeNull();
});

test("rejects traversal that escapes cwd", () => {
  expect(resolveInsideRepo(CWD, "../secret")).toBeNull();
  expect(resolveInsideRepo(CWD, "src/../../x")).toBeNull();
});

test("a file whose NAME starts with two dots is inside, not an escape", () => {
  // `rel.startsWith("..")` is true for `..hidden` — the same naive-prefix bug
  // this file's sibling-directory test exists to prevent, one level down.
  expect(resolveInsideRepo(CWD, "..hidden")).toBe("/Users/v/repo/..hidden");
  expect(resolveInsideRepo(CWD, "src/..bak.ts")).toBe("/Users/v/repo/src/..bak.ts");
});

test("keeps traversal that stays inside cwd", () => {
  expect(resolveInsideRepo(CWD, "src/../docs/a.md")).toBe("/Users/v/repo/docs/a.md");
});

test("a sibling directory sharing the cwd prefix is OUTSIDE — the classic startsWith bug", () => {
  expect(resolveInsideRepo(CWD, "/Users/v/repo-other/x.ts")).toBeNull();
  expect(resolveInsideRepo(CWD, "/Users/v/repository/x.ts")).toBeNull();
});

test("cwd itself resolves to the empty relative path and is kept", () => {
  expect(resolveInsideRepo(CWD, ".")).toBe("/Users/v/repo");
});

test("a trailing slash on cwd does not change the verdict", () => {
  expect(resolveInsideRepo(CWD + "/", "src/a.ts")).toBe("/Users/v/repo/src/a.ts");
  expect(resolveInsideRepo(CWD + "/", "/tmp/x.log")).toBeNull();
});

test("degrades to null on unusable input rather than throwing", () => {
  expect(resolveInsideRepo(CWD, "")).toBeNull();
  expect(resolveInsideRepo("", "src/a.ts")).toBeNull();
  expect(resolveInsideRepo(CWD, undefined as unknown as string)).toBeNull();
});
