// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Table-driven cover of every branch of spec section 4's decision tree.
 *
 * Test names carry the AC id they close, per the user story.
 */
import { describe, expect, test } from "bun:test";
import {
  decideReviewUnit,
  NUDGE_QUIET_MINUTES,
  NUDGE_UNCOMMITTED_LINES,
  type ReviewUnitFacts,
} from "../../src/router/review-unit";

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T1 = "1111111111111111111111111111111111111111";
const T2 = "2222222222222222222222222222222222222222";

/** A repo where nothing has happened: HEAD matches the anchor. */
function quiet(over: Partial<ReviewUnitFacts> = {}): ReviewUnitFacts {
  return {
    head: A,
    tree: T1,
    storedHead: A,
    storedTree: T1,
    unit: "commit",
    uncommittedLines: 0,
    minutesSinceLastReview: 1,
    ...over,
  };
}

describe("decideReviewUnit — failure paths", () => {
  test("AC14 — no git facts means no repo: skip, never throw", () => {
    const d = decideReviewUnit({ unit: "commit" });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("not_a_git_repo");
    // Nothing to advance to — an anchor must not be written from absent facts.
    expect(d.advanceAnchorTo).toBeUndefined();
  });

  test("AC14 — a resolvable head with an unresolvable tree is still not a repo", () => {
    // Guards the half-fact case: `head` present, `tree` absent. A check that
    // only tested `head` would let an undefined tree reach the comparison below
    // and silently read as "tree changed".
    const d = decideReviewUnit({ head: A, unit: "commit" });
    expect(d.reason).toBe("not_a_git_repo");
  });

  // REVISED 2026-08-26 (the maintainer): this pair asserted a SKIP. Skipping meant a
  // fresh install stayed silent until the author's first commit — a price
  // nobody had named. It now reviews the working tree ONCE (the pre-axis
  // behaviour) and adopts HEAD.
  test("AC15 — first run has no anchor: review the working tree once, adopt HEAD", () => {
    const d = decideReviewUnit({ head: A, tree: T1, unit: "commit" });
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("anchor_unusable");
    expect(d.advanceAnchorTo).toEqual({ head: A, tree: T1 });
    // No boundary exists yet, so none may be claimed. An absent range is what
    // sends git-diff back to the working tree; a range built from a head this
    // repo does not have would be a confidently wrong diff.
    expect(d.revisionRange).toBeUndefined();
  });

  test("AC15 — an anchor git no longer knows (rebase / force-push) recovers", () => {
    const d = decideReviewUnit({
      head: B,
      tree: T2,
      storedHead: A,
      storedTree: T1,
      storedHeadVanished: true,
      unit: "commit",
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("anchor_unusable");
    expect(d.advanceAnchorTo).toEqual({ head: B, tree: T2 });
    // The dangerous alternative: firing with `A..B` where A is unreachable.
    expect(d.revisionRange).toBeUndefined();
  });
});

describe("decideReviewUnit — the commit unit", () => {
  test("AC1/AC3 — HEAD unmoved: skip, and say which rule said so", () => {
    const d = decideReviewUnit(quiet());
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no_new_commit");
    expect(d.advanceAnchorTo).toBeUndefined();
  });

  test("AC2 — a new commit fires with exactly that commit's range", () => {
    const d = decideReviewUnit(quiet({ head: B, tree: T2 }));
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("new_commit");
    expect(d.revisionRange).toBe(`${A}..${B}`);
    expect(d.advanceAnchorTo).toEqual({ head: B, tree: T2 });
  });

  test("AC4 — two commits in one turn yield ONE range spanning both", () => {
    // The anchor is the boundary, so N commits between anchor and HEAD produce
    // a single delimited range rather than an undelimited `git log -p` blob.
    // This is the #668 class: the caller now names the boundary instead of the
    // diff tool guessing where one commit ends.
    const d = decideReviewUnit(quiet({ head: B, tree: T2 }));
    expect(d.revisionRange).toBe(`${A}..${B}`);
    expect(d.revisionRange).toContain("..");
  });

  test("AC16 — HEAD moved but the tree is identical: amend, so no review", () => {
    const d = decideReviewUnit(quiet({ head: B, tree: T1 }));
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("tree_unchanged");
  });

  test("AC16 — an amend still advances the anchor, or it re-fires forever", () => {
    const d = decideReviewUnit(quiet({ head: B, tree: T1 }));
    expect(d.advanceAnchorTo).toEqual({ head: B, tree: T1 });
  });

  test("an anchor written before trees were stored does NOT read as unchanged", () => {
    // Upgrade path. Absent storedTree must not be conflated with "same tree",
    // which would silently suppress the first real review after an upgrade.
    const d = decideReviewUnit({
      head: B,
      tree: T1,
      storedHead: A,
      storedTree: undefined,
      unit: "commit",
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("new_commit");
  });
});

describe("decideReviewUnit — the PR unit", () => {
  test("AC5 — on a branch, the range is the whole branch", () => {
    const d = decideReviewUnit(
      quiet({ head: B, tree: T2, unit: "pr", onDefaultBranch: false, mergeBase: A }),
    );
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("branch_grew");
    expect(d.revisionRange).toBe(`${A}..${B}`);
  });

  test("AC6 — on the default branch there is no branch to diff: fall back, and say so", () => {
    const d = decideReviewUnit(
      quiet({ head: B, tree: T2, unit: "pr", onDefaultBranch: true, mergeBase: A }),
    );
    expect(d.fire).toBe(true);
    // The fallback is NAMED, not silent — the whole point of D6.
    expect(d.reason).toBe("pr_fallback_to_commit");
    expect(d.revisionRange).toBe(`${A}..${B}`);
  });

  test("AC6 — an unresolvable merge-base falls back rather than firing on nothing", () => {
    const d = decideReviewUnit(
      quiet({ head: B, tree: T2, unit: "pr", onDefaultBranch: false, mergeBase: undefined }),
    );
    expect(d.fire).toBe(true);
    expect(d.reason).toBe("pr_fallback_to_commit");
    expect(d.revisionRange).toBe(`${A}..${B}`);
  });

  test("the pr unit does not bypass the skip paths", () => {
    // A configured unit must not become a reason to review an unmoved HEAD.
    const d = decideReviewUnit(quiet({ unit: "pr", onDefaultBranch: false, mergeBase: A }));
    expect(d.fire).toBe(false);
    expect(d.reason).toBe("no_new_commit");
  });
});

describe("decideReviewUnit — the quiet-path nudge (AC13)", () => {
  test("fires when both thresholds are passed", () => {
    const d = decideReviewUnit(
      quiet({
        uncommittedLines: NUDGE_UNCOMMITTED_LINES + 1,
        minutesSinceLastReview: NUDGE_QUIET_MINUTES + 1,
      }),
    );
    expect(d.nudge).toBe(true);
    // A nudge is NOT a review. AC13 requires zero Brain calls, and `fire`
    // false is what makes that structural rather than promised.
    expect(d.fire).toBe(false);
  });

  test("needs BOTH thresholds, not either", () => {
    const loudButRecent = decideReviewUnit(
      quiet({ uncommittedLines: NUDGE_UNCOMMITTED_LINES + 1, minutesSinceLastReview: 1 }),
    );
    expect(loudButRecent.nudge).toBe(false);

    const quietButClean = decideReviewUnit(
      quiet({ uncommittedLines: 0, minutesSinceLastReview: NUDGE_QUIET_MINUTES + 1 }),
    );
    expect(quietButClean.nudge).toBe(false);
  });

  test("the thresholds are exclusive, so a value exactly AT one does not fire", () => {
    const d = decideReviewUnit(
      quiet({
        uncommittedLines: NUDGE_UNCOMMITTED_LINES,
        minutesSinceLastReview: NUDGE_QUIET_MINUTES,
      }),
    );
    expect(d.nudge).toBe(false);
  });

  test("a fresh install with never-reviewed state counts as quiet, not as zero", () => {
    // Absent `minutesSinceLastReview` means no review has ever run here.
    // Treating it as 0 would silence the nudge exactly where a dead-looking
    // pet costs the most.
    const d = decideReviewUnit({
      head: A,
      tree: T1,
      storedHead: A,
      storedTree: T1,
      unit: "commit",
      uncommittedLines: NUDGE_UNCOMMITTED_LINES + 1,
      minutesSinceLastReview: undefined,
    });
    expect(d.nudge).toBe(true);
  });

  test("a firing review does not also nudge", () => {
    const d = decideReviewUnit(
      quiet({
        head: B,
        tree: T2,
        uncommittedLines: NUDGE_UNCOMMITTED_LINES + 1,
        minutesSinceLastReview: NUDGE_QUIET_MINUTES + 1,
      }),
    );
    expect(d.fire).toBe(true);
    expect(d.nudge).toBeUndefined();
  });
});

describe("decideReviewUnit — D6: no unlabelled exit", () => {
  const cases: Array<[string, ReviewUnitFacts]> = [
    ["no repo", { unit: "commit" }],
    ["no anchor", { head: A, tree: T1, unit: "commit" }],
    ["unmoved", quiet()],
    ["amended", quiet({ head: B, tree: T1 })],
    ["new commit", quiet({ head: B, tree: T2 })],
    ["branch grew", quiet({ head: B, tree: T2, unit: "pr", onDefaultBranch: false, mergeBase: A })],
    ["pr on default", quiet({ head: B, tree: T2, unit: "pr", onDefaultBranch: true })],
    ["vanished anchor", quiet({ head: B, tree: T2, storedHeadVanished: true })],
  ];

  for (const [name, facts] of cases) {
    test(`${name} carries a reason`, () => {
      const d = decideReviewUnit(facts);
      expect(typeof d.reason).toBe("string");
      expect(d.reason.length).toBeGreaterThan(0);
    });
  }

  test("a range is named exactly when there is a boundary to name", () => {
    for (const [name, facts] of cases) {
      const d = decideReviewUnit(facts);
      if (!d.fire) {
        expect(d.revisionRange, `${name} skipped but named a range`).toBeUndefined();
        continue;
      }
      // The ONE fire with no range, named rather than left as a hole in the
      // invariant: with no usable anchor there is no boundary, so the review
      // falls back to the working tree. Claiming a range here would mean
      // building one from a head this repo may not even have.
      if (d.reason === "anchor_unusable") {
        expect(d.revisionRange, `${name} claimed a range it cannot have`).toBeUndefined();
        continue;
      }
      expect(d.revisionRange, `${name} fired without a range`).toBeDefined();
    }
  });

  test("the range-less fire is reachable from exactly one reason", () => {
    // Guards the exception above from widening: if a second reason ever starts
    // firing without a range, this fails rather than the invariant quietly
    // covering it.
    const rangeless = cases
      .map(([, facts]) => decideReviewUnit(facts))
      .filter((d) => d.fire && d.revisionRange === undefined)
      .map((d) => d.reason);
    // Two cases reach it — no anchor, and an anchor git has lost — so the
    // claim is about the set of REASONS, not the count of cases.
    expect(rangeless.length).toBeGreaterThan(0);
    expect([...new Set(rangeless)]).toEqual(["anchor_unusable"]);
  });
});
