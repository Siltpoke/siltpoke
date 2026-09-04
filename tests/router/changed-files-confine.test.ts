// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// `confineToCwd` — drop changed-file paths that are not inside the repo.
//
// The transcript records every path a tool touched, so a shell redirect to
// /tmp, a scratchpad script under /private/tmp, and `> /dev/null` all entered
// `changed_files` alongside real source edits. Measured over 125 August
// critiques in this repo: 1264 of 2086 entries (60%) were repo-external, and
// 124 of the 125 critiques carried at least one. They are not inert — the
// god-file rubric fired on a 9915-line /tmp build log (critique c-193a, which
// also reported `rubric_suppressed_count: 17`), and that finding became the
// critique's anchors[0], which the acted-on oracle could never read.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractChangedFiles } from "../../src/router/context";

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-confine-"));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** One transcript whose tool_use events name each of `paths`. */
function transcriptNaming(paths: string[]): string {
  const p = join(tmp, "t.jsonl");
  writeFileSync(
    p,
    paths
      .map((file_path) =>
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Edit", input: { file_path } }] },
        }),
      )
      .join("\n"),
  );
  return p;
}

test("drops repo-external paths and keeps in-repo ones", async () => {
  const inside = join(repo, "src/a.ts");
  const p = transcriptNaming([
    inside,
    "/tmp/ci-2-signal.log",
    "/dev/null",
    join(tmp, "scratchpad/mklabels.py"),
  ]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files).toEqual([inside]);
});

test("keeps a cwd-relative path — it is inside by construction", async () => {
  const p = transcriptNaming(["src/a.ts", "/tmp/x.log"]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files).toEqual(["src/a.ts"]);
});

test("keeps the path in the form the transcript wrote it — filter only, no rewrite", async () => {
  // Downstream (rubric, evidence corpus, anchors) reads these strings; changing
  // absolute to relative here would silently re-point every consumer.
  const inside = join(repo, "src/a.ts");
  const p = transcriptNaming([inside]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files[0]).toBe(inside);
});

test("a sibling repo sharing the cwd prefix is dropped", async () => {
  // Paired with a real in-repo path on purpose: a sibling-only transcript would
  // trip the all-dropped fail-safe below and this assertion would pass for the
  // wrong reason.
  const inside = join(repo, "src/a.ts");
  const sibling = join(tmp, "repo-other", "src/a.ts");
  const p = transcriptNaming([sibling, inside]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files).toEqual([inside]);
});

// --- positive controls: the filter must not fire when it was not asked for ---

test("OFF by default — the same transcript keeps everything", async () => {
  const p = transcriptNaming([join(repo, "src/a.ts"), "/tmp/ci-2-signal.log"]);
  const files = await extractChangedFiles(p, { cwd: repo });
  expect(files).toContain("/tmp/ci-2-signal.log");
  expect(files.length).toBe(2);
});

test("without a cwd nothing is dropped — never drop on doubt", async () => {
  const p = transcriptNaming(["/tmp/ci-2-signal.log", "src/a.ts"]);
  const files = await extractChangedFiles(p, { confineToCwd: true });
  expect(files).toEqual(["/tmp/ci-2-signal.log", "src/a.ts"]);
});

// --- fail-safe: confinement must never silence the critic entirely ---

test("keeps everything when confinement would drop EVERY path", async () => {
  // A cwd that does not contain any edited file means the cwd is wrong, not
  // that the session edited nothing real — agy `-p` sends no workspacePaths, so
  // event.cwd falls back to the host's own config dir. Dropping all of them
  // there would leave the critic with zero changed files and silently no review
  // at all, which is worse than the repo-external noise this filter exists for.
  const p = transcriptNaming(["/elsewhere/a.ts", "/elsewhere/b.ts"]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files).toEqual(["/elsewhere/a.ts", "/elsewhere/b.ts"]);
});

test("the fail-safe does NOT engage when at least one path survives", async () => {
  const inside = join(repo, "src/a.ts");
  const p = transcriptNaming([inside, "/elsewhere/a.ts"]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files).toEqual([inside]);
});

test("an already-empty transcript stays empty — the fail-safe invents nothing", async () => {
  const p = transcriptNaming([]);
  const files = await extractChangedFiles(p, { cwd: repo, confineToCwd: true });
  expect(files).toEqual([]);
});

test("composes with pruneMissing rather than replacing it", async () => {
  // in-repo but deleted → pruneMissing's job; repo-external → confineToCwd's.
  const present = join(repo, "src/a.ts");
  writeFileSync(present, "x");
  const gone = join(repo, "src/gone.ts");
  const p = transcriptNaming([present, gone, "/tmp/ci-2-signal.log"]);
  const files = await extractChangedFiles(p, {
    cwd: repo,
    confineToCwd: true,
    pruneMissing: true,
  });
  expect(files).toEqual([present]);
});
