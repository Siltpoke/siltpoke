// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * AC2 + AC4 — what an explicit revision range does to cross-commit attribution.
 *
 * #668 fixed the recent-commits fallback by stripping every inline commit
 * header and naming exactly ONE commit as the review subject. That kept a
 * lower commit's message off an upper commit's hunks, but it did not remove
 * the situation: the named subject is one commit while the hunks on the table
 * span several, and the only thing holding that together is a
 * `backgroundCommits` count the reviewer has to read and honour.
 *
 * D2 removes the situation instead. When the caller names the boundary, the
 * blob handed to the reviewer is a plain two-tree diff: no commit headers, no
 * named subject, nothing to mis-attach.
 *
 * The AC4 assertion is written ONCE, in `assertNoCrossCommitAttribution`, and
 * run against BOTH paths — passing on the range path and **failing** on the
 * fallback. That is the red-drive the plan requires: a fix whose own assertion
 * has never been seen failing is a guard nobody has proven can fire.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../../src/critic/spawn";
import { runGitDiff, runRecentCommitsDiff } from "../../../src/critic/tools/run-git-diff";
import type { ReviewSubject } from "../../../src/critic/tools/review-subject";

// A `commit <40hex>` line at column 0 can only be a git-log header: diff body
// lines all carry a `+`/`-`/space prefix and `git log` indents message lines by
// four spaces. Same discriminator `cross-commit-attribution.test.ts` uses.
const COMMIT_HEADER_RE = /^commit ([0-9a-f]{40})$/gm;

function commitHeaders(text: string): string[] {
  return [...text.matchAll(COMMIT_HEADER_RE)].map((m) => m[1]!);
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-reviewrange-"));
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

async function commitFile(dir: string, file: string, body: string, msg: string) {
  writeFileSync(join(dir, file), body);
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", msg);
}

/**
 * The anchor commit, then TWO commits inside one turn — the AC4 scenario.
 * Returns the sha the anchor would hold, i.e. where the last review stopped.
 */
async function seedTurnWithTwoCommits(dir: string): Promise<string> {
  await gitInit(dir);
  await commitFile(dir, "anchor.ts", "export const anchor = 0;\n", "anchor: reviewed already");
  const anchorSha = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
  await commitFile(dir, "first.ts", "export const first = 1;\n", "first: the earlier of the pair");
  await commitFile(dir, "second.ts", "export const second = 2;\n", "second: the later of the pair");
  return anchorSha;
}

interface DiffPayload {
  raw: string;
  reviewSubject?: ReviewSubject;
}

/**
 * AC4, as one predicate.
 *
 * Two halves, and both matter: the reviewer must SEE both commits' work
 * (a range that narrows to the newest commit would also have no attribution
 * problem, by having lost half the change), and no single commit may be
 * named as the subject of that blob.
 */
function assertNoCrossCommitAttribution(payload: DiffPayload, filesOnTheTable: string[]): void {
  for (const file of filesOnTheTable) {
    expect(payload.raw).toContain(file);
  }
  expect(commitHeaders(payload.raw)).toEqual([]);
  expect(payload.reviewSubject).toBeUndefined();
}

describe("AC4 — two commits in one turn, handed over as one range", () => {
  test("the range carries both commits' hunks and names no commit as the subject", async () => {
    const anchorSha = await seedTurnWithTwoCommits(tmp);

    const result = await runGitDiff({ cwd: tmp, revisionRange: `${anchorSha}..HEAD` });

    expect(result.status).toBe("ok");
    assertNoCrossCommitAttribution(result, ["first.ts", "second.ts"]);
    // The already-reviewed commit stays out: the range starts where the last
    // review stopped, so its file must not reappear.
    expect(result.raw).not.toContain("anchor.ts");
  });

  test("neither commit message reaches the reviewer at all", async () => {
    const anchorSha = await seedTurnWithTwoCommits(tmp);

    const result = await runGitDiff({ cwd: tmp, revisionRange: `${anchorSha}..HEAD` });

    // Not "the right message is attached to the right hunks" — there is no
    // message on the table to attach. That is what makes AC4 structural
    // rather than a parser that has to keep getting it right.
    expect(result.raw).not.toContain("first: the earlier of the pair");
    expect(result.raw).not.toContain("second: the later of the pair");
  });

  test("RED-DRIVE — the same assertion FAILS on the old recent-commits fallback", async () => {
    await seedTurnWithTwoCommits(tmp);

    const fb = await runRecentCommitsDiff({ cwd: tmp });
    expect(fb).not.toBeNull();

    // Quoted rather than left to a bare `.toThrow()`: the fallback puts ONE
    // commit header and ONE named subject in front of a blob spanning more
    // than that commit. Those two facts ARE the failure.
    const leakedHeaders = commitHeaders(fb!.raw);
    expect(leakedHeaders).toHaveLength(1);
    expect(fb!.reviewSubject).toBeDefined();
    expect(fb!.reviewSubject!.backgroundCommits).toBeGreaterThan(0);

    // The failure is captured and IDENTIFIED rather than swallowed by a bare
    // `.toThrow()`: "the suite went red" is not the same claim as "the
    // assertion I am proving went red". Pinning the message to the leaked sha
    // is what distinguishes them — a red caused by a missing file, or by the
    // fixture failing to build, would not carry it.
    let failure: unknown;
    try {
      assertNoCrossCommitAttribution(fb!, ["first.ts", "second.ts"]);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeDefined();
    expect(String((failure as Error).message)).toContain(leakedHeaders[0]!);
  });
});

describe("AC2 — the range is the commit's diff, not the working tree's", () => {
  test("uncommitted work is excluded from the range, and IS included without one", async () => {
    await gitInit(tmp);
    await commitFile(tmp, "anchor.ts", "export const anchor = 0;\n", "anchor: reviewed already");
    const anchorSha = (await git(tmp, "rev-parse", "HEAD")).stdout.trim();
    await commitFile(tmp, "committed.ts", "export const committed = 1;\n", "the commit under review");
    // Work in progress that the author has NOT stood behind yet.
    writeFileSync(join(tmp, "scratch.ts"), "export const scratch = 999;\n");
    await git(tmp, "add", ".");

    const ranged = await runGitDiff({ cwd: tmp, revisionRange: `${anchorSha}..HEAD` });
    expect(ranged.raw).toContain("committed.ts");
    expect(ranged.raw).not.toContain("scratch.ts");

    // Positive control: without a range the SAME repo hands over the working
    // tree instead. Without this the first two assertions are also satisfied
    // by a git call that simply returned nothing.
    const unranged = await runGitDiff({ cwd: tmp });
    expect(unranged.raw).toContain("scratch.ts");
  });
});
