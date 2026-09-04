import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolOutputSection } from "../../../src/brain/prompt-tools";
import { spawnWithTimeout } from "../../../src/critic/spawn";
import { formatReviewSubjectBlock, splitRecentCommitsLog } from "../../../src/critic/tools/review-subject";
import { runRecentCommitsDiff } from "../../../src/critic/tools/run-git-diff";
import type { ToolName, ToolResult } from "../../../src/critic/tools/types";

// A `commit <40hex>` line at column 0 can only be a git-log header: every line
// of a diff body carries a `+`/`-`/space prefix, and every line of a commit
// message is indented four spaces by `git log`. That makes this anchor the
// exact discriminator for "how many commit-message blocks reached the reviewer".
const COMMIT_HEADER_RE = /^commit ([0-9a-f]{40})$/gm;

function commitHeaders(text: string): string[] {
  return [...text.matchAll(COMMIT_HEADER_RE)].map((m) => m[1]!);
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-crosscommit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function git(dir: string, ...argv: string[]) {
  return spawnWithTimeout({
    argv: ["git", ...argv],
    cwd: dir,
    timeoutMs: 5000,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00",
    } as Record<string, string>,
  });
}

async function gitInit(dir: string) {
  await git(dir, "init");
  await git(dir, "config", "user.email", "test@test.com");
  await git(dir, "config", "user.name", "Test User");
}

/** Three commits, each touching its own file, newest last. */
async function seedThreeCommits(dir: string): Promise<{ shas: string[] }> {
  await gitInit(dir);
  const specs = [
    { file: "oldest.ts", body: "export const oldest = 1;\n", msg: "oldest: add the oldest module" },
    { file: "middle.ts", body: "export const middle = 2;\n", msg: "middle: add the middle module" },
    { file: "newest.ts", body: "export const newest = 3;\n", msg: "newest: add the newest module" },
  ];
  for (const s of specs) {
    writeFileSync(join(dir, s.file), s.body);
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", s.msg);
  }
  const log = await git(dir, "log", "--format=%H", "-3", "HEAD");
  const shas = log.stdout.trim().split("\n"); // newest first
  return { shas };
}

/**
 * Mirrors what `src/critic/phases/tools.ts` does with a fallback result: every
 * field it copies onto the git-diff ToolResult, `reviewSubject` included. Dropping
 * that field here would test an assembly path production does not run.
 */
function assembleResults(
  fb: NonNullable<Awaited<ReturnType<typeof runRecentCommitsDiff>>>,
): Record<ToolName, ToolResult> {
  const nonOk = (tool: ToolName): ToolResult =>
    ({ tool, status: "not_applicable", parsed: [], raw: "" }) as ToolResult;
  return {
    tsc: nonOk("tsc"),
    eslint: nonOk("eslint"),
    "git-diff": {
      tool: "git-diff",
      status: "ok",
      parsed: fb.parsed,
      raw: fb.raw,
      reviewSubject: fb.reviewSubject,
    },
    ripgrep: nonOk("ripgrep"),
  };
}

function assembleSection(
  fb: NonNullable<Awaited<ReturnType<typeof runRecentCommitsDiff>>>,
): string {
  return buildToolOutputSection(assembleResults(fb)).section;
}

describe("cross-commit attribution — the recent-commits fallback", () => {
  test("the raw blob carries exactly one commit-message block, and it is the newest commit", async () => {
    const { shas } = await seedThreeCommits(tmp);
    const newest = shas[0]!;

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    expect(fb).not.toBeNull();

    expect(commitHeaders(fb!.raw)).toEqual([newest]);
  });

  test("the assembled tool output carries exactly one commit-message block, and it is the newest commit", async () => {
    const { shas } = await seedThreeCommits(tmp);
    const newest = shas[0]!;

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const section = assembleSection(fb!);

    expect(commitHeaders(section)).toEqual([newest]);
  });

  test("the two older commit messages are absent from the assembled tool output", async () => {
    await seedThreeCommits(tmp);

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const section = assembleSection(fb!);

    expect(section).toContain("newest: add the newest module");
    expect(section).not.toContain("middle: add the middle module");
    expect(section).not.toContain("oldest: add the oldest module");
  });

  test("all three commits' diffs survive — the fix keeps the context, it does not narrow to one commit", async () => {
    await seedThreeCommits(tmp);

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const section = assembleSection(fb!);

    for (const file of ["oldest.ts", "middle.ts", "newest.ts"]) {
      expect(section).toContain(file);
    }
  });

  test("the citation corpus carries the commit block but NOT siltpoke's own notice", async () => {
    const { shas } = await seedThreeCommits(tmp);
    const newest = shas[0]!;

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const { section, citationSection } = buildToolOutputSection(assembleResults(fb!));

    // The notice is siltpoke prose. If the evidence guard accepts it as verbatim
    // tool output, a critique can quote siltpoke back at itself and pass — the
    // same reason the partial-coverage notice is held out of this corpus.
    expect(section).toContain("REVIEW SUBJECT");
    expect(citationSection).not.toContain("REVIEW SUBJECT");

    // The commit line and its message ARE real git output, so they stay citable —
    // and the one-block invariant has to hold on this surface too.
    expect(commitHeaders(citationSection)).toEqual([newest]);
    expect(citationSection).toContain("newest: add the newest module");
  });

  test("the reviewer is told how many background commits it is looking at", async () => {
    await seedThreeCommits(tmp);

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    expect(fb!.reviewSubject).toBeDefined();
    expect(fb!.reviewSubject!.backgroundCommits).toBe(2);
  });
});

describe("the named subject must have contributed the diff it is judged against", () => {
  test("a merge commit at HEAD is not named as the subject of hunks it did not write", async () => {
    // `git log -p` shows no diff for an ordinary merge. Naming it as the review
    // subject hands the reviewer a message belonging to none of the code below —
    // the exact invariant this whole fix exists to hold: the message a scope-check
    // judges must come from the same object as the diff it judges.
    await gitInit(tmp);
    writeFileSync(join(tmp, "base.ts"), "export const base = 0;\n");
    await git(tmp, "add", ".");
    await git(tmp, "commit", "-m", "base: the root commit");

    const trunk = (await git(tmp, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    await git(tmp, "checkout", "-b", "side");
    writeFileSync(join(tmp, "side.ts"), "export const side = 1;\n");
    await git(tmp, "add", ".");
    await git(tmp, "commit", "-m", "side: add the side module");

    await git(tmp, "checkout", trunk);
    writeFileSync(join(tmp, "trunk.ts"), "export const trunk = 2;\n");
    await git(tmp, "add", ".");
    await git(tmp, "commit", "-m", "trunk: add the trunk module");
    await git(tmp, "merge", "--no-ff", "side", "-m", "Merge branch 'side'");

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const subject = fb!.reviewSubject!;

    // The merge contributed nothing, so it cannot be the subject.
    expect(subject.message).not.toContain("Merge branch");
    expect(subject.message).toContain("trunk: add the trunk module");

    // And the count must describe commits that actually put a diff on the table.
    // Two did (trunk, side); saying "spans 3" over a 2-commit diff is a new
    // falsehood, not a rounding error.
    expect(subject.backgroundCommits).toBe(1);
  });

  test("an empty commit at HEAD is not named as the subject either", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "real.ts"), "export const real = 1;\n");
    await git(tmp, "add", ".");
    await git(tmp, "commit", "-m", "real: the commit that actually changed something");
    await git(tmp, "commit", "--allow-empty", "-m", "empty: touched nothing at all");

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const subject = fb!.reviewSubject!;

    expect(subject.message).not.toContain("empty: touched nothing");
    expect(subject.message).toContain("real: the commit that actually changed");
    expect(subject.backgroundCommits).toBe(0);
  });
});

describe("which surface carries what", () => {
  test("siltpoke's own notice never enters the raw blob", async () => {
    // `raw` is persisted by writeCriticSnapshot, replayed to the chat model as
    // `diff_text`, and fed to the Haiku pre-pass. Prose at byte 0 of something
    // every one of those reads as a diff is a shape none of them expects — and on
    // the zero-hunk path `raw` goes into the evidence corpus unscoped, which would
    // let a critique quote siltpoke's own instruction and pass the verbatim guard.
    await seedThreeCommits(tmp);

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    expect(fb!.raw).not.toContain("REVIEW SUBJECT");
    // The commit line and its message DO stay: those are real `git log` output,
    // and the pre-pass reads them to infer intent.
    expect(fb!.raw).toContain("newest: add the newest module");
  });

  test("the raw blob and the assembled section name the same single commit", async () => {
    // Two call sites render from the same ReviewSubject. If they ever diverge, the
    // one-block assertion silently narrows to whichever surface the tests check.
    await seedThreeCommits(tmp);

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    const section = assembleSection(fb!);

    expect(commitHeaders(fb!.raw)).toEqual(commitHeaders(section));
    expect(commitHeaders(fb!.raw)).toHaveLength(1);
  });
});

describe("splitRecentCommitsLog — shapes the fallback can be handed", () => {
  test("a single-commit blob says so instead of claiming background commits", async () => {
    await gitInit(tmp);
    writeFileSync(join(tmp, "only.ts"), "export const only = 1;\n");
    await git(tmp, "add", ".");
    await git(tmp, "commit", "-m", "only: the one and only commit");

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    expect(fb!.reviewSubject!.backgroundCommits).toBe(0);

    const block = formatReviewSubjectBlock(fb!.reviewSubject!);
    // The multi-commit wording would be an outright lie on a one-commit blob:
    // there is nothing to hold apart, and naming background commits that do not
    // exist is the same class of untrue framing this whole fix removes.
    expect(block.shown).toContain("the diff below is this one commit");
    expect(block.shown).not.toContain("BACKGROUND");
  });

  test("a blob with no commit header is passed through untouched, not emptied", () => {
    // What `git diff` (no log headers at all) looks like. Emptying it would turn
    // legitimate citations into unverified ones — the same fail-soft posture
    // scopeDiffRawToFiles takes on a shape it does not recognise.
    const plainDiff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");

    const { subject, diffOnly } = splitRecentCommitsLog(plainDiff);
    expect(subject).toBeNull();
    expect(diffOnly).toBe(plainDiff);
  });

  test("a message line cannot forge a second commit header", () => {
    // git indents every message line four spaces, so a message that literally
    // quotes a commit header still cannot produce a column-0 match. This is the
    // property the whole assertion rests on.
    const sha = "a".repeat(40);
    const decoy = "b".repeat(40);
    const blob = [
      `commit ${sha}`,
      "Author: Test User <test@test.com>",
      "Date:   Mon Jan 1 00:00:00 2024 -0800",
      "",
      // Deliberately shaped so that DEDENTING the message would produce a
      // column-0 `commit <40hex>` line. Keeping git's four-space indent is what
      // makes the forge impossible; a fixture whose decoy survives dedenting
      // would pass this test for the wrong reason.
      `    commit ${decoy}`,
      "    revert of the above",
      "",
      "---",
      " a.ts | 1 +",
      "",
      "diff --git a/a.ts b/a.ts",
      "--- /dev/null",
      "+++ b/a.ts",
      "@@ -0,0 +1 @@",
      "+const a = 1;",
    ].join("\n");

    const { subject } = splitRecentCommitsLog(blob);
    expect(subject!.sha).toBe(sha);
    expect(commitHeaders(formatReviewSubjectBlock(subject!).shown)).toEqual([sha]);
  });
});
