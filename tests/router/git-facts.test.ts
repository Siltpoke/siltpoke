// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Fixture-repo cover for the I/O half of the review-trigger-unit decision.
 *
 * The pure decision tree is covered without git in `review-unit.test.ts`.
 * THESE are the cases that only a real repository can produce: amend, rebase,
 * a vanished anchor, a non-repo cwd.
 *
 * Fixtures are built under the OS temp dir, never under a synced folder — a
 * fixture read out of the iCloud tree has stalled for up to 88 seconds and
 * surfaces as a subprocess timeout rather than as a storage problem.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReviewUnitFacts,
  readAnchor,
  resolveDefaultBranch,
  writeAnchor,
} from "../../src/router/git-facts";
import { decideReviewUnit } from "../../src/router/review-unit";

const roots: string[] = [];

/**
 * `-c core.excludesFile=/dev/null` makes this fixture hermetic.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` below silences the global CONFIG, but git's
 * default excludes file is `$XDG_CONFIG_HOME/git/ignore` and it is read whether
 * or not any config mentions it. This machine has `.siltpoke/` in that file, so
 * `git add -A` here quietly skipped the anchor `anchorHere` writes — while CI,
 * which has no such file, committed it and saw an extra path in every range
 * assertion. Three tests were green on one machine and red everywhere else.
 *
 * **Stated precisely, because "both fixes are load-bearing" would be a nicer
 * sentence than the true one:** the fix that makes these tests pass is the
 * `.gitignore` `newRepo` now writes. Removing this flag alone changes nothing
 * here — measured. What this flag buys is that the fixture no longer depends on
 * whatever the ambient environment happens to ignore, so the next such
 * divergence cannot hide the same way.
 */
function sh(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "core.excludesFile=/dev/null", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return new TextDecoder().decode(r.stdout).trim();
}

/** A repo on `main` with one commit, plus an empty `.siltpoke` state dir. */
function newRepo(): { cwd: string; stateBase: string } {
  const cwd = mkdtempSync(join(tmpdir(), "rtu-"));
  roots.push(cwd);
  sh(cwd, ["init", "-q", "-b", "main"]);
  // The fixture ignores its own state directory, the way a repo with siltpoke
  // installed does (this repo's `.gitignore:13` carries `.siltpoke/*`). Without
  // it, `anchorHere` writes a file that the next `add -A` commits, and every
  // range assertion gains a path that has nothing to do with the test. It is
  // written into the FIRST commit so it never appears in a later range itself.
  writeFileSync(join(cwd, ".gitignore"), ".siltpoke/\n");
  writeFileSync(join(cwd, "a.txt"), "one\n");
  sh(cwd, ["add", "-A"]);
  sh(cwd, ["commit", "-q", "-m", "first"]);
  const stateBase = join(cwd, ".siltpoke");
  mkdirSync(stateBase, { recursive: true });
  return { cwd, stateBase };
}

function head(cwd: string): string {
  return sh(cwd, ["rev-parse", "HEAD"]);
}

function tree(cwd: string): string {
  return sh(cwd, ["rev-parse", "HEAD^{tree}"]);
}

/** Anchor the repo at its current state, as a completed review would. */
function anchorHere(cwd: string, stateBase: string, reviewedAt = new Date().toISOString()): void {
  writeAnchor(stateBase, { head: head(cwd), tree: tree(cwd), reviewedAt });
}

beforeAll(() => {
  // Fail loudly rather than silently skipping if git is unavailable — a suite
  // that quietly tests nothing is the failure this repo keeps finding.
  const probe = Bun.spawnSync(["git", "--version"]);
  expect(probe.exitCode).toBe(0);
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("collectReviewUnitFacts — repo detection", () => {
  test("AC14 — a cwd that is not a git repo yields no head/tree", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rtu-norepo-"));
    roots.push(cwd);
    const facts = await collectReviewUnitFacts({ cwd, stateBase: cwd, unit: "commit" });
    expect(facts.head).toBeUndefined();
    expect(facts.tree).toBeUndefined();
    expect(decideReviewUnit(facts).reason).toBe("not_a_git_repo");
  });

  test("a real repo yields a head and a tree, and they are different objects", async () => {
    const { cwd, stateBase } = newRepo();
    const facts = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    expect(facts.head).toMatch(/^[0-9a-f]{40}$/);
    expect(facts.tree).toMatch(/^[0-9a-f]{40}$/);
    // A commit sha and its tree sha are never the same; equal values would mean
    // one of the two rev-parse calls is reading the wrong thing.
    expect(facts.head).not.toBe(facts.tree);
  });
});

describe("collectReviewUnitFacts — end to end against real git operations", () => {
  test("AC15 — no anchor on first contact: review the working tree once, adopt HEAD", async () => {
    const { cwd, stateBase } = newRepo();
    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("anchor_unusable");
    expect(d.revisionRange).toBeUndefined();
    expect(d.advanceAnchorTo?.head).toBe(head(cwd));
  });

  test("AC1/AC3 — anchored and idle: no review", async () => {
    const { cwd, stateBase } = newRepo();
    anchorHere(cwd, stateBase);
    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no_new_commit");
  });

  test("AC2 — a real commit fires with a range git itself accepts", async () => {
    const { cwd, stateBase } = newRepo();
    const before = head(cwd);
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "a.txt"), "two\n");
    sh(cwd, ["commit", "-qam", "second"]);

    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("new_commit");
    expect(d.revisionRange).toBe(`${before}..${head(cwd)}`);

    // The range is not merely well-formed — git resolves it, and it names
    // exactly the one file the commit touched.
    const named = sh(cwd, ["diff", "--name-only", d.revisionRange!]);
    expect(named).toBe("a.txt");
  });

  test("AC4 — two commits since the anchor produce ONE range covering both", async () => {
    const { cwd, stateBase } = newRepo();
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "b.txt"), "b\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-qm", "add b"]);
    writeFileSync(join(cwd, "c.txt"), "c\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-qm", "add c"]);

    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.fire).toBe(true);
    // Both commits' files, from one delimited range — no `git log -p` blob in
    // which one commit's header can be swallowed into the previous commit's
    // last hunk (the #668 class).
    const named = sh(cwd, ["diff", "--name-only", d.revisionRange!]).split("\n").sort();
    expect(named).toEqual(["b.txt", "c.txt"]);
  });

  test("AC16 — `commit --amend` of a message alone does not fire", async () => {
    const { cwd, stateBase } = newRepo();
    anchorHere(cwd, stateBase);
    const treeBefore = tree(cwd);
    sh(cwd, ["commit", "-q", "--amend", "-m", "first, reworded"]);

    // Precondition, asserted rather than assumed: the amend really did move
    // HEAD while leaving the tree identical. Without this the test could pass
    // for the wrong reason.
    expect(tree(cwd)).toBe(treeBefore);

    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("tree_unchanged");
    expect(d.advanceAnchorTo?.head).toBe(head(cwd));
  });

  test("AC16 — an amend that CHANGES content still fires", async () => {
    const { cwd, stateBase } = newRepo();
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "a.txt"), "different\n");
    sh(cwd, ["commit", "-qam", "first", "--amend"]);
    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.fire).toBe(true);
  });

  test("AC15 — an anchor pointing at a commit git no longer has recovers", async () => {
    const { cwd, stateBase } = newRepo();
    // A sha of the right shape that this repo has never contained.
    writeAnchor(stateBase, {
      head: "0".repeat(40),
      tree: "0".repeat(40),
      reviewedAt: new Date().toISOString(),
    });
    const facts = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    expect(facts.storedHeadVanished).toBe(true);
    const d = decideReviewUnit(facts);
    expect(d.reason).toBe("anchor_unusable");
    expect(d.revisionRange).toBeUndefined();
  });

  test("a corrupt anchor file is treated as no anchor, not as a crash", async () => {
    const { cwd, stateBase } = newRepo();
    writeFileSync(join(stateBase, "review-anchor.json"), "{not json");
    expect(readAnchor(stateBase)).toBeUndefined();
    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" }));
    expect(d.reason).toBe("anchor_unusable");
  });
});

describe("the PR unit against real branches (spec R2)", () => {
  test("resolves a local trunk by existence, never by assuming `main`", async () => {
    const { cwd } = newRepo();
    expect(await resolveDefaultBranch(cwd)).toBe("main");
  });

  test("a repo whose trunk is neither main nor master resolves to nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rtu-trunk-"));
    roots.push(cwd);
    sh(cwd, ["init", "-q", "-b", "develop"]);
    writeFileSync(join(cwd, "a.txt"), "one\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-q", "-m", "first"]);
    // The honest outcome: unknown, rather than a confident wrong answer.
    expect(await resolveDefaultBranch(cwd)).toBeUndefined();
  });

  test("AC6 — an unresolvable trunk degrades to the commit unit, and SAYS so", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rtu-trunk2-"));
    roots.push(cwd);
    sh(cwd, ["init", "-q", "-b", "develop"]);
    writeFileSync(join(cwd, "a.txt"), "one\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-q", "-m", "first"]);
    const stateBase = join(cwd, ".siltpoke");
    mkdirSync(stateBase, { recursive: true });
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "a.txt"), "two\n");
    sh(cwd, ["commit", "-qam", "second"]);

    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "pr" }));
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("pr_fallback_to_commit");
  });

  test("AC5 — on a feature branch the range spans the whole branch", async () => {
    const { cwd, stateBase } = newRepo();
    const trunkTip = head(cwd);
    sh(cwd, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(cwd, "b.txt"), "b\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-qm", "one"]);
    // Anchored mid-branch: the PR unit must still reach back to the trunk,
    // which is what distinguishes it from the commit unit.
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "c.txt"), "c\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-qm", "two"]);

    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "pr" }));
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("branch_grew");
    expect(d.revisionRange).toBe(`${trunkTip}..${head(cwd)}`);
    const named = sh(cwd, ["diff", "--name-only", d.revisionRange!]).split("\n").sort();
    // BOTH branch commits — the commit unit would have shown only c.txt.
    expect(named).toEqual(["b.txt", "c.txt"]);
  });

  test("AC6 — sitting on the trunk itself falls back rather than going silent", async () => {
    const { cwd, stateBase } = newRepo();
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "a.txt"), "two\n");
    sh(cwd, ["commit", "-qam", "second"]);
    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "pr" }));
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("pr_fallback_to_commit");
  });

  /**
   * KNOWN LIMITATION, asserted so it cannot change without someone noticing.
   * A branch stacked on another feature branch has no way to declare its real
   * base, so merge-base with the trunk reaches past the parent branch and the
   * range includes the parent's commits too. Recorded rather than fixed.
   */
  test("a stacked branch over-reports: the range includes the parent branch", async () => {
    const { cwd, stateBase } = newRepo();
    sh(cwd, ["checkout", "-q", "-b", "parent"]);
    writeFileSync(join(cwd, "parent.txt"), "p\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-qm", "parent work"]);
    sh(cwd, ["checkout", "-q", "-b", "child"]);
    anchorHere(cwd, stateBase);
    writeFileSync(join(cwd, "child.txt"), "c\n");
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-qm", "child work"]);

    const d = decideReviewUnit(await collectReviewUnitFacts({ cwd, stateBase, unit: "pr" }));
    const named = sh(cwd, ["diff", "--name-only", d.revisionRange!]).split("\n").sort();
    expect(named).toEqual(["child.txt", "parent.txt"]);
  });
});

describe("uncommitted-line counting and the anchor clock", () => {
  test("a clean tree counts zero uncommitted lines", async () => {
    const { cwd, stateBase } = newRepo();
    const facts = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    expect(facts.uncommittedLines).toBe(0);
  });

  test("unstaged and staged work both count", async () => {
    const { cwd, stateBase } = newRepo();
    writeFileSync(join(cwd, "a.txt"), "1\n2\n3\n");
    const unstaged = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    expect(unstaged.uncommittedLines).toBeGreaterThan(0);

    sh(cwd, ["add", "-A"]);
    const staged = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    // `diff HEAD` spans the index too; a staged-only change must not read as a
    // clean tree, which would silence the nudge for anyone who stages early.
    expect(staged.uncommittedLines).toBe(unstaged.uncommittedLines);
  });

  test("minutes-since-review is measured from the anchor, not from now", async () => {
    const { cwd, stateBase } = newRepo();
    const twoHoursAgo = new Date(Date.parse("2026-08-26T10:00:00Z"));
    anchorHere(cwd, stateBase, twoHoursAgo.toISOString());
    const facts = await collectReviewUnitFacts({
      cwd,
      stateBase,
      unit: "commit",
      now: new Date(Date.parse("2026-08-26T12:00:00Z")),
    });
    expect(facts.minutesSinceLastReview).toBe(120);
  });

  test("an anchor with no timestamp leaves the clock absent, not zero", async () => {
    const { cwd, stateBase } = newRepo();
    writeAnchor(stateBase, { head: head(cwd), tree: tree(cwd), reviewedAt: "" });
    const facts = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    // Absent means "never reviewed", which the nudge treats as maximally quiet.
    // Zero would mean "just reviewed" — the opposite claim.
    expect(facts.minutesSinceLastReview).toBeUndefined();
  });

  test("a pre-D3 anchor with no tree reaches the decision as ABSENT", async () => {
    const { cwd, stateBase } = newRepo();
    writeFileSync(
      join(stateBase, "review-anchor.json"),
      JSON.stringify({ head: head(cwd), reviewedAt: new Date().toISOString() }),
    );
    const facts = await collectReviewUnitFacts({ cwd, stateBase, unit: "commit" });
    expect(facts.storedTree).toBeUndefined();
  });
});
