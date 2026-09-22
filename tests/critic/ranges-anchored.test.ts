// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Whether a derived line number describes the file a reader would open.
 *
 * The question has one answer per git invocation, and both halves of it are
 * silent when wrong: a window with a merge in it still parses into perfectly
 * ordinary-looking hunks, and a mis-split range still resolves to a string.
 * Neither would raise anything — the reviewer would simply print a line number
 * for the wrong version of the file, or print none and never say why.
 */
import { describe, expect, test } from "bun:test";
import { splitRecentCommitsLog } from "../../src/critic/tools/review-subject";
import { rangeRightSide, runGitDiff } from "../../src/critic/tools/run-git-diff";

/**
 * `git log --pretty=medium -p` as git actually writes it.
 *
 * Full 40-character shas on purpose: `--no-abbrev-commit` is pinned in the
 * argv, and the header regex requires them. A short sha here would make every
 * test in this block pass through the no-headers early return and assert
 * nothing — which is how the first draft of this file printed a green `false`.
 */
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_M = "c".repeat(40);

const commit = (sha: string, subject: string, merge?: string) =>
  [
    `commit ${sha}`,
    ...(merge === undefined ? [] : [`Merge: ${merge}`]),
    "Author: A <a@example.com>",
    "Date:   Sat Sep 20 01:00:00 2026 +0000",
    "",
    `    ${subject}`,
    "",
  ].join("\n");

const fileDiff = [
  "diff --git a/src/pay.ts b/src/pay.ts",
  "--- a/src/pay.ts",
  "+++ b/src/pay.ts",
  "@@ -1,1 +1,2 @@",
  " ctx",
  "+added",
].join("\n");

describe("a merge in the window is detected from the headers already in hand", () => {
  test("a plain window has no merge", () => {
    const log = [commit(SHA_A, "one"), fileDiff, commit(SHA_B, "two"), fileDiff].join("\n");
    expect(splitRecentCommitsLog(log).windowHasMerge).toBe(false);
  });

  /**
   * The case the whole flag exists for. Under plain `-p` git emits NO patch for
   * a merge, so the merge is dropped below and the newest surviving block is an
   * ancestor on one side of it — whose `+` side line numbers are relative to
   * that side's parent, not to the file at HEAD.
   */
  test("a merge commit sets the flag even though it contributes no diff", () => {
    const log = [
      commit(SHA_M, "Merge pull request #1", `${SHA_A} ${SHA_B}`),
      commit(SHA_A, "one"),
      fileDiff,
    ].join("\n");
    const split = splitRecentCommitsLog(log);
    expect(split.windowHasMerge).toBe(true);
    // And the merge really did contribute nothing, which is why its presence
    // has to be recorded separately from the diff.
    expect(split.subject?.sha).toBe(SHA_A);
  });

  test("output with no commit headers at all reports no merge rather than throwing", () => {
    expect(splitRecentCommitsLog(fileDiff).windowHasMerge).toBe(false);
  });
});

describe("the ref on the new side of a range", () => {
  test("two dots", () => {
    expect(rangeRightSide("abc123..HEAD")).toBe("HEAD");
  });

  /**
   * MUTATION RUN: `indexOf` in place of `lastIndexOf` returns `.HEAD` here,
   * which resolves to nothing, and every `review` CLI run silently loses its
   * line numbers. `src/cli/review.ts` builds exactly this shape.
   */
  test("THREE dots — the shape the review CLI builds", () => {
    expect(rangeRightSide("main...HEAD")).toBe("HEAD");
  });

  test("a bare ref is its own right side", () => {
    expect(rangeRightSide("HEAD~3")).toBe("HEAD~3");
  });

  test("a branch name containing a slash survives", () => {
    expect(rangeRightSide("origin/main..origin/feat/x")).toBe("origin/feat/x");
  });
});

describe("runGitDiff answers the question for the path it took", () => {
  /**
   * No range means `git diff HEAD`, which compares against the WORKING TREE —
   * so its `+` side is the file on disk by definition, whatever state the repo
   * is in. This runs against the repo itself, so it needs no fixture.
   */
  test("a working-tree diff is anchored", async () => {
    const result = await runGitDiff({ cwd: process.cwd() });
    expect(result.status).toBe("ok");
    expect(result.rangesAnchored).toBe(true);
  });

  /**
   * A range whose right side is not HEAD can never be anchored, whatever the
   * working tree looks like — the `+` side is an older commit's file.
   *
   * Runs against a purpose-built three-commit repository, NOT `process.cwd()`.
   * Reading the ambient repo made this test depend on the checkout having at
   * least three commits, which is an assumption about the environment and not
   * about the code: in a fresh-history checkout `HEAD~2` does not resolve,
   * `runGitDiff` correctly answers `not_applicable`, and the assertion below
   * fails for a reason that has nothing to do with anchoring. Measured
   * 2026-09-21 against the public snapshot, whose whole history is one commit.
   */
  test("a range ending somewhere other than HEAD is not anchored", async () => {
    const dir = repoWithThreeCommits();
    try {
      const result = await runGitDiff({ cwd: dir, revisionRange: "HEAD~2..HEAD~1" });
      expect(result.status).toBe("ok");
      expect(result.rangesAnchored).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unparseable range is refused before anything is spawned", async () => {
    const result = await runGitDiff({ cwd: process.cwd(), revisionRange: "$(rm -rf /)" });
    expect(result.status).toBe("error");
    expect(result.rangesAnchored).toBeUndefined();
  });
});

/**
 * The delivery half: the answer has to REACH the guard.
 *
 * Every test above reads the flag off `runGitDiff`'s return value, which says
 * nothing about whether anything downstream uses it. These run against real
 * temporary repositories, because the two cases that decide the common path —
 * a range ending at HEAD on a clean tree, and the same range on a dirty one —
 * cannot be faked: they are what `git rev-parse` and `git diff --quiet` answer.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runToolsPhase } from "../../src/critic/phases/tools";
import { runTools } from "../../src/critic/tools/run-tools";
import { getProjectCapabilities } from "../../src/critic/capabilities";

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function repoWithTwoCommits(): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-anchored-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "src/pay.ts"), "export const rate = 0.05;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "one"]);
  writeFileSync(join(dir, "src/pay.ts"), "export const rate = 0.05;\nexport const tax = 0.2;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "two"]);
  return dir;
}

/** The same repository with one more commit on top, so `HEAD~2..HEAD~1` is a
 * real range that ends somewhere other than HEAD. */
function repoWithThreeCommits(): string {
  const dir = repoWithTwoCommits();
  writeFileSync(
    join(dir, "src/pay.ts"),
    "export const rate = 0.05;\nexport const tax = 0.2;\nexport const fee = 1;\n",
  );
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "three"]);
  return dir;
}

describe("a range ending at HEAD, against a real repository", () => {
  /**
   * The case no earlier test reached: `computeRangesAnchored` returning TRUE
   * through the range branch. Mutating its final `return sameCommit &&
   * dirty.exitCode === 0` to `false` leaves every other test in this file green.
   */
  test("clean tree: anchored", async () => {
    const dir = repoWithTwoCommits();
    try {
      const r = await runGitDiff({ cwd: dir, revisionRange: "HEAD~1..HEAD" });
      expect(r.status).toBe("ok");
      expect(r.rangesAnchored).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The half [D3] says is the one actually doing work. The range is identical;
   * only the working tree differs, so this isolates the `git diff --quiet HEAD`
   * spawn from the `rev-parse` comparison.
   */
  test("dirty tree: NOT anchored, same range", async () => {
    const dir = repoWithTwoCommits();
    try {
      writeFileSync(join(dir, "src/pay.ts"), "export const rate = 0.06;\n");
      const r = await runGitDiff({ cwd: dir, revisionRange: "HEAD~1..HEAD" });
      expect(r.status).toBe("ok");
      expect(r.rangesAnchored).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `phases/tools.ts` REBUILDS the git-diff tool result on the clean-tree
 * fallback rather than patching it, so a field left off there is lost with
 * nothing to say so. Deleting `rangesAnchored: fallback.rangesAnchored` makes
 * every clean-tree review lose its line numbers, and before this test nothing
 * went red.
 */
describe("the clean-tree fallback carries the answer through the rebuild", () => {
  test("a clean tree with no merge in the window stays anchored", async () => {
    const dir = repoWithTwoCommits();
    try {
      const phase = await runToolsPhase({
        cwd: dir,
        changedFiles: ["src/pay.ts"],
        caps: await getProjectCapabilities(dir),
        homeBase: dir,
        source: "stop-hook",
        sessionId: "s-anchored",
        runToolsFn: runTools,
      });
      expect(phase.ok).toBe(true);
      const gd = phase.ok ? phase.toolResults["git-diff"] : undefined;
      expect(gd?.tool).toBe("git-diff");
      // The fallback fired: a clean tree means `git diff HEAD` was empty.
      expect(gd?.tool === "git-diff" && gd.reviewSubject !== undefined).toBe(true);
      expect(gd?.tool === "git-diff" && gd.rangesAnchored).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
