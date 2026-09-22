// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The banner exists because of one measured confusion, not a hypothetical:
 * critique `c-2722` (2026-09-17) was ~3 hours old and carried the branch the
 * user was actually on — both signals said "current" — while the diff it read
 * contained none of the files that had changed. A timestamp alone would have
 * printed a reassuring line over a review about a merged PR.
 *
 * So the load-bearing test is not "does it print the time". It is: does it
 * fire on THAT case.
 *
 * Audience note: this banner is for a CODING AGENT — `/siltpoke-last` exists
 * to paste a review into one — so it is deliberately more than one line. The
 * statusline bubble is the opposite surface and gets `[10:44] "…"` alone; that
 * split is tested in `tests/face/wrapper.test.ts`.
 */
import { test, expect } from "bun:test";
import {
  changedSince,
  humanAge,
  parseFrontmatter,
  renderFreshness,
} from "../../src/cli/critique-freshness";

const NOW = new Date("2026-09-17T19:00:00Z");
const THREE_HOURS_AGO = "2026-09-17T16:02:20.953Z";

/** git stub: no commits since, no dirty files, on the given branch. */
function quietGit(branch: string) {
  return (args: string[], _cwd: string): string | null => {
    if (args[0] === "rev-parse") return `${branch}\n`;
    return "";
  };
}

const base = { cwd: "/repo", now: NOW };

test("[1] the age is stated in words, not left as arithmetic", () => {
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: "fix/x",
    evidenceLabel: "verified",
    gitFn: quietGit("fix/x"),
  });
  expect(out).toContain("3 hours ago");
  expect(out).toContain("16:02");
  expect(out).toContain("fix/x");
});

test("[2] the c-2722 case: same branch, recent, but files changed since — it fires", () => {
  const gitFn = (args: string[], _cwd: string): string | null => {
    if (args[0] === "rev-parse") return "fix/example-change\n";
    if (args[0] === "log") return "src/brain/brain.ts\nsrc/cli/wake.ts\n";
    if (args.includes("--cached")) return "src/brain/envelope.ts\n";
    return "";
  };
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: "fix/example-change",
    evidenceLabel: "no_evidence",
    gitFn,
  });
  // The line that would have saved the user the misread.
  expect(out).toContain("3 files changed since it ran");
  expect(out).toContain("did not see them");
  expect(out).toContain("src/brain/envelope.ts");
  // And the no-citation fact, which is the other half of why it said nothing.
  expect(out).toContain("cited no code");
});

test("[2] device check — with nothing changed since, neither warning fires", () => {
  // Without this, a banner that always warns would pass the test above.
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: "fix/x",
    evidenceLabel: "verified",
    gitFn: quietGit("fix/x"),
  });
  expect(out).not.toContain("changed since it ran");
  expect(out).not.toContain("cited no code");
});

test("[2] a different branch is called out as other work", () => {
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: "feat/other",
    evidenceLabel: "verified",
    gitFn: quietGit("main"),
  });
  expect(out).toContain("It is about other work");
});

test("build output sorts last so real work is what the sample shows", () => {
  // The first live run listed five dist/*.js bundles and pushed every src/
  // file past the cap — the one line meant to say "it did not see YOUR work"
  // showed only build artifacts.
  const gitFn = (args: string[], _cwd: string): string | null => {
    if (args[0] === "rev-parse") return "fix/x\n";
    if (args[0] === "log")
      return [
        "dist/a.js",
        "dist/b.js",
        "dist/c.js",
        "dist/d.js",
        "dist/e.js",
        "bun.lock",
        "src/cli/get-critique.ts",
        "src/state/critique.ts",
      ].join("\n");
    return "";
  };
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: "fix/x",
    evidenceLabel: null,
    gitFn,
  });
  expect(out).toContain("8 files changed since it ran");
  // Both src files survive the 6-item cap...
  expect(out).toContain("src/cli/get-critique.ts");
  expect(out).toContain("src/state/critique.ts");
  // ...and nothing was hidden: the count is whole and dist is still sampled.
  expect(out).toContain("dist/a.js");
  expect(out).toContain("and 2 more");
});

test("older critiques (no branch line) still get the age, and no invented branch", () => {
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: null,
    evidenceLabel: null,
    gitFn: quietGit("main"),
  });
  expect(out).toContain("3 hours ago");
  expect(out).not.toContain("Branch");
  expect(out).not.toContain("other work");
});

test("no timestamp → no banner at all, rather than a banner that guesses", () => {
  expect(
    renderFreshness({ ...base, timestamp: null, branch: "x", evidenceLabel: null, gitFn: quietGit("x") }),
  ).toBe("");
  expect(
    renderFreshness({
      ...base,
      timestamp: "not-a-date",
      branch: "x",
      evidenceLabel: null,
      gitFn: quietGit("x"),
    }),
  ).toBe("");
});

test("git failing everywhere degrades to the age, no crash", () => {
  const out = renderFreshness({
    ...base,
    timestamp: THREE_HOURS_AGO,
    branch: "fix/x",
    evidenceLabel: null,
    gitFn: () => null,
  });
  expect(out).toContain("3 hours ago");
  expect(out).not.toContain("changed since it ran");
});

test("changedSince unions commits, working tree and index, deduped", () => {
  const gitFn = (args: string[], _cwd: string): string | null => {
    if (args[0] === "log") return "a.ts\nb.ts\n";
    if (args.includes("--cached")) return "b.ts\nc.ts\n";
    if (args[0] === "diff") return "c.ts\nd.ts\n";
    return "";
  };
  expect(changedSince(THREE_HOURS_AGO, "/repo", gitFn)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
});

test("humanAge rounds AGE up, the safe direction for a staleness warning", () => {
  // 2h57m must not read as "2 hours" — understating age is what makes a stale
  // review look current. Opposite convention to brain-health's countdown.
  expect(humanAge(177 * 60_000)).toBe("3 hours ago");
});

test("humanAge stays coarse and does not fold hours into days too early", () => {
  expect(humanAge(30_000)).toBe("just now");
  expect(humanAge(5 * 60_000)).toBe("5 minutes ago");
  expect(humanAge(60 * 60_000)).toBe("1 hour ago");
  // 26h is not "yesterday" when you worked past midnight.
  expect(humanAge(26 * 60 * 60_000)).toBe("26 hours ago");
  expect(humanAge(72 * 60 * 60_000)).toBe("3 days ago");
  expect(humanAge(-1000)).toContain("clock skew");
});

test("frontmatter parsing picks the three fields and tolerates their absence", () => {
  const md = [
    "---",
    "schemaVersion: 1",
    "timestamp: 2026-09-17T16:02:20.953Z",
    "branch: fix/example-change",
    "evidence_label: no_evidence",
    "status: pending",
    "---",
    "",
    "# body",
  ].join("\n");
  expect(parseFrontmatter(md)).toEqual({
    timestamp: "2026-09-17T16:02:20.953Z",
    branch: "fix/example-change",
    evidenceLabel: "no_evidence",
  });
  expect(parseFrontmatter("no frontmatter here")).toEqual({
    timestamp: null,
    branch: null,
    evidenceLabel: null,
  });
});
