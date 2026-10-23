// A file the agent created this turn and never `git add`ed is UNTRACKED, and
// `git diff HEAD` does not show untracked files. Before this, such a file was
// invisible to the review — and with nothing else changed, the tool fell back
// to the previous commit, so the AI reviewed unrelated old code instead
// (2026-10-22 sandbox: the agent wrote billing.ts, the AI reviewed a.ts).
//
// runGitDiff now adds the untracked files among `untrackedCandidates` (the
// turn's changed files) as whole-file additions — working-tree case only.
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitDiff } from "../../../src/critic/tools/run-git-diff";
import { spawnWithTimeout } from "../../../src/critic/spawn";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-untracked-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function git(dir: string, ...args: string[]): Promise<void> {
  await spawnWithTimeout({
    argv: ["git", ...args],
    cwd: dir,
    timeoutMs: 5000,
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-01T00:00:00", GIT_COMMITTER_DATE: "2024-01-01T00:00:00" } as Record<string, string>,
  });
}

async function repoWithOneCommit(dir: string): Promise<void> {
  await git(dir, "init");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test User");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "init");
}

const files = (r: Awaited<ReturnType<typeof runGitDiff>>) => [...new Set(r.parsed.map((h) => h.file))].sort();

describe("runGitDiff — untracked files the turn created", () => {
  test("an untracked candidate appears as a whole-file addition", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "billing.ts"), "export function charge(id: string) {\n  return id;\n}\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "billing.ts")] });
    expect(r.status).toBe("ok");
    expect(files(r)).toEqual(["billing.ts"]);
    const hunk = r.parsed.find((h) => h.file === "billing.ts")!;
    expect(hunk.body).toContain("+export function charge(id: string) {");
    expect(hunk.newLines).toBe(3);
    expect(r.raw).toContain("billing.ts");
  });

  test("relative candidate paths work too", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "b.ts"), "export const b = 2;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: ["b.ts"] });
    expect(files(r)).toEqual(["b.ts"]);
  });

  test("a tracked edit and an untracked new file are both reviewed", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(tmp, "new.ts"), "export const n = 3;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "a.ts"), join(tmp, "new.ts")] });
    expect(files(r)).toEqual(["a.ts", "new.ts"]);
  });

  test("an untracked file the turn did NOT touch is left out", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "scratch.ts"), "export const s = 1;\n");
    writeFileSync(join(tmp, "mine.ts"), "export const m = 1;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "mine.ts")] });
    expect(files(r)).toEqual(["mine.ts"]);
  });

  test("a gitignored candidate is left out", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, ".gitignore"), "out.log\n");
    await git(tmp, "add", ".gitignore");
    await git(tmp, "commit", "-m", "ignore");
    writeFileSync(join(tmp, "out.log"), "noise\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "out.log")] });
    expect(r.status).toBe("ok");
    expect(r.parsed).toEqual([]);
  });

  test("a candidate that is a tracked, unchanged file adds nothing", async () => {
    await repoWithOneCommit(tmp);
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "a.ts")] });
    expect(r.parsed).toEqual([]);
  });

  test("paths are repo-root-relative when cwd is a subdirectory, matching git diff HEAD", async () => {
    await repoWithOneCommit(tmp);
    mkdirSync(join(tmp, "pkg"));
    writeFileSync(join(tmp, "pkg", "c.ts"), "export const c = 1;\n");
    const r = await runGitDiff({ cwd: join(tmp, "pkg"), untrackedCandidates: [join(tmp, "pkg", "c.ts")] });
    expect(files(r)).toEqual(["pkg/c.ts"]);
  });

  test("at most 20 untracked files are added", async () => {
    await repoWithOneCommit(tmp);
    const cands: string[] = [];
    for (let i = 0; i < 25; i++) {
      const p = join(tmp, `f${String(i).padStart(2, "0")}.ts`);
      writeFileSync(p, `export const v${i} = ${i};\n`);
      cands.push(p);
    }
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: cands });
    expect(files(r)).toHaveLength(20);
  });

  test("with a revision range, untracked files are not mixed into the committed unit", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "a.ts"), "export const a = 9;\n");
    await git(tmp, "commit", "-am", "second");
    writeFileSync(join(tmp, "loose.ts"), "export const l = 1;\n");
    const r = await runGitDiff({ cwd: tmp, revisionRange: "HEAD~1..HEAD", untrackedCandidates: [join(tmp, "loose.ts")] });
    expect(files(r)).toEqual(["a.ts"]);
  });

  test("no candidates → behaviour unchanged (an untracked file is still not shown)", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "billing.ts"), "export const x = 1;\n");
    const r = await runGitDiff({ cwd: tmp });
    expect(r.status).toBe("ok");
    expect(r.parsed).toEqual([]);
  });

  test("a file name with a space is read correctly (git adds a trailing TAB)", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "sp ace.ts"), "export const s = 1;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "sp ace.ts")] });
    expect(files(r)).toEqual(["sp ace.ts"]);
  });

  test("a non-ASCII file name is read correctly (git C-quotes it)", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "naïve 计费.ts"), "export const n = 1;\n");
    writeFileSync(join(tmp, "z.ts"), "export const z = 1;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "naïve 计费.ts"), join(tmp, "z.ts")] });
    // Two files, each its own hunk — the quoted one is not folded into its neighbour.
    expect(files(r)).toEqual(["naïve 计费.ts", "z.ts"]);
    expect(r.parsed).toHaveLength(2);
  });

  test("a candidate outside the repo is ignored, the rest still added", async () => {
    await repoWithOneCommit(tmp);
    const outside = mkdtempSync(join(tmpdir(), "siltpoke-outside-"));
    try {
      writeFileSync(join(outside, "x.ts"), "export const x = 1;\n");
      writeFileSync(join(tmp, "in.ts"), "export const i = 1;\n");
      const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(outside, "x.ts"), join(tmp, "in.ts")] });
      expect(files(r)).toEqual(["in.ts"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an untracked file over 256 KB is skipped", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "huge.js"), "x\n".repeat(200_000));
    writeFileSync(join(tmp, "small.ts"), "export const s = 1;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "huge.js"), join(tmp, "small.ts")] });
    expect(files(r)).toEqual(["small.ts"]);
    expect(r.raw).not.toContain("huge.js");
  });

  test("a deleted tracked file is filed under its own name, not the previous file's", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "b.ts"), "export const b = 1;\n");
    await git(tmp, "add", "b.ts");
    await git(tmp, "commit", "-m", "b");
    writeFileSync(join(tmp, "a.ts"), "export const a = 2;\n");
    rmSync(join(tmp, "b.ts"));
    const r = await runGitDiff({ cwd: tmp });
    expect(files(r)).toEqual(["a.ts", "b.ts"]);
    const del = r.parsed.find((h) => h.file === "b.ts")!;
    expect(del.newLines).toBe(0);
  });

  test("an added line that starts with '++ ' is not taken for a file header", async () => {
    await repoWithOneCommit(tmp);
    // Two hunks in one file, far apart. The first adds a line `++ b/evil.ts`,
    // which git prints as `+++ b/evil.ts`. If that were read as a header, the
    // SECOND hunk would be filed under evil.ts.
    const lines = Array.from({ length: 40 }, (_, k) => `export const v${k} = ${k};`);
    writeFileSync(join(tmp, "long.ts"), `${lines.join("\n")}\n`);
    await git(tmp, "add", "long.ts");
    await git(tmp, "commit", "-m", "long");
    const edited = [...lines];
    edited.splice(2, 0, "++ b/evil.ts");
    edited[38] = "export const v37 = 999;";
    writeFileSync(join(tmp, "long.ts"), `${edited.join("\n")}\n`);
    const r = await runGitDiff({ cwd: tmp });
    expect(r.parsed.length).toBeGreaterThanOrEqual(2);
    expect(files(r)).toEqual(["long.ts"]);
  });

  test("a binary untracked candidate adds no hunk and does not break the diff", async () => {
    await repoWithOneCommit(tmp);
    writeFileSync(join(tmp, "img.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    writeFileSync(join(tmp, "ok.ts"), "export const ok = 1;\n");
    const r = await runGitDiff({ cwd: tmp, untrackedCandidates: [join(tmp, "img.bin"), join(tmp, "ok.ts")] });
    expect(r.status).toBe("ok");
    expect(files(r)).toEqual(["ok.ts"]);
  });
});
