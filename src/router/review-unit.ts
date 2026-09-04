// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The ⏱ review-trigger-unit decision.
 *
 * Replaces `trigger-modes.ts`, whose only question was "is this hook event
 * `Stop` or `PreCompact`" — i.e. "did the agent stop talking". Measured over
 * 39,422 real triggers that axis blocked 2 (`wrong_event_mode`), and two of
 * its four settings gate on a wake marker whose command was deleted in #279.
 *
 * This asks instead: HAS A UNIT OF WORK CLOSED? A commit is the first moment
 * the author says "this much, I stand behind".
 *
 * The function is PURE on purpose. Every git read lives in `./git-facts.ts`,
 * so the whole decision tree is exercisable without a repository, and the
 * failure modes that need a real repo (amend, rebase, force-push) are isolated
 * to one small I/O module instead of being tangled through the logic.
 *
 * Spec: an internal design note (D1-D9)
 * Story: an internal design note
 */

/** The replacement axis. `commit` is the default; see D8. */
export type ReviewUnit = "commit" | "pr";

/**
 * The same two values as data, so the UI does not restate them.
 *
 * This module has NO imports, which is why it can be the one source: the
 * dashboard's `<select>` (`src/web/screens/timeline/review-unit-row.tsx`) and
 * the island that POSTs the choice (`src/web/client/islands/review-unit.ts`)
 * both import it, and both ship in the browser bundle. Before this existed
 * each of them carried its own literal list, so adding a third unit to the
 * `<select>` would have rendered a clickable option that the island then
 * refused as `unknown review unit` — a drift no test covered.
 *
 * The server's allowlist (`sanitizeConfigPatch`) still spells the values out
 * separately, on purpose: a boundary that validated against a list the client
 * also feeds would validate nothing. `tests/web/client/islands/review-unit.test.ts`
 * asserts the two agree, in both directions.
 */
export const REVIEW_UNITS = ["commit", "pr"] as const satisfies readonly ReviewUnit[];

export function isReviewUnit(v: string): v is ReviewUnit {
  return (REVIEW_UNITS as readonly string[]).includes(v);
}

/**
 * Every reason a decision can carry. D6: a gate that skips without naming the
 * rule that skipped it is the exact failure this track exists to delete, so
 * there is no unlabelled exit from `decideReviewUnit`.
 */
export type ReviewSkipReason =
  /** cwd is not a git repo, or a git call failed. AC14. */
  | "not_a_git_repo"
  /** HEAD has not moved since the last review. AC1, AC3. */
  | "no_new_commit"
  /** HEAD moved but the tree is identical — amend, or a pure relocation. AC16. */
  | "tree_unchanged";

/** Why a review fired, so the ledger can distinguish the two units. */
export type ReviewFireReason =
  | "new_commit"
  | "branch_grew"
  /** `pr` was configured but there is no branch to diff; fell back. AC6. */
  | "pr_fallback_to_commit"
  /**
   * No anchor yet, or the anchor names a commit git no longer knows. AC15.
   *
   * REVISED 2026-08-26 (the maintainer), and the old shape is named rather than
   * quietly replaced: this was a SKIP (`head_unresolvable`). Skipping meant a
   * fresh install stayed silent for as long as the author went without
   * committing — install siltpoke, work all afternoon, hear nothing. AC15 asks
   * for "a defined state rather than reviewing the entire history"; reviewing
   * the WORKING TREE once is such a state, and it is also exactly what
   * siltpoke did before this axis existed. So the first turn in a repo behaves
   * as it always did, the anchor is written, and every turn after it is on the
   * new axis.
   *
   * Carries NO `revisionRange` on purpose — there is no boundary to name yet,
   * so git-diff keeps its old working-tree behaviour.
   */
  | "anchor_unusable";

export interface ReviewUnitFacts {
  /** Absent when cwd is not a git repo or `rev-parse` failed. */
  head?: string;
  /** Tree object of HEAD. Absent for the same reasons as `head`. */
  tree?: string;
  /** The anchor's head. Absent on first run. */
  storedHead?: string;
  /** The anchor's tree. Absent on first run, or on a pre-D3 anchor. */
  storedTree?: string;
  /** True when git could not resolve `storedHead` — rebased or force-pushed away. */
  storedHeadVanished?: boolean;
  unit: ReviewUnit;
  /** True when HEAD is the repo's default branch, so there is no branch to diff. */
  onDefaultBranch?: boolean;
  /** merge-base(default, HEAD). Absent when it could not be resolved. */
  mergeBase?: string;
  /** Lines changed in the working tree but not committed. Drives the nudge. */
  uncommittedLines?: number;
  /** Absent when no review has ever run here. */
  minutesSinceLastReview?: number;
}

export interface ReviewUnitDecision {
  fire: boolean;
  reason: ReviewSkipReason | ReviewFireReason;
  /** Present only when `fire` is true. What the reviewer should be shown. */
  revisionRange?: string;
  /**
   * True when the pet should say something about uncommitted work. NEVER
   * implies a Brain call — AC13 requires zero. Orthogonal to `fire`.
   */
  nudge?: boolean;
  /**
   * The anchor should advance to this head/tree. Present whenever the decision
   * consumed a HEAD move — INCLUDING `tree_unchanged`, because an amend that
   * leaves the anchor stale re-fires this decision forever.
   */
  advanceAnchorTo?: { head: string; tree: string };
}

/**
 * Thresholds for the quiet-path nudge (D9 / AC13.1).
 *
 * BOTH NUMBERS ARE GUESSES. Nothing measured them. the maintainer chose (OQ3,
 * 2026-08-26) to pick a number now and write down that it is a guess, so that
 * data can correct it later rather than opinion. They live here, named, so one
 * measurement moves them in one place — not at three call sites.
 */
export const NUDGE_UNCOMMITTED_LINES = 200;
export const NUDGE_QUIET_MINUTES = 30;

/**
 * Should the pet mention uncommitted work? Zero Brain calls, by construction:
 * this returns a boolean and nothing here can reach a model.
 */
function shouldNudge(facts: ReviewUnitFacts): boolean {
  const lines = facts.uncommittedLines ?? 0;
  // Absent `minutesSinceLastReview` means no review has EVER run here. That is
  // quiet by any definition, so it counts as past the threshold rather than
  // being treated as zero — which would silence the nudge exactly on a fresh
  // install, the one place the pet looking dead is most costly.
  const quietFor = facts.minutesSinceLastReview ?? Number.POSITIVE_INFINITY;
  return lines > NUDGE_UNCOMMITTED_LINES && quietFor > NUDGE_QUIET_MINUTES;
}

/**
 * The whole decision. See spec section 4 for the tree this implements.
 */
export function decideReviewUnit(facts: ReviewUnitFacts): ReviewUnitDecision {
  // AC14 — no repo, or git failed. Never throw into the hook.
  if (facts.head === undefined || facts.tree === undefined) {
    return { fire: false, reason: "not_a_git_repo" };
  }

  const here = { head: facts.head, tree: facts.tree };

  // AC15 — no anchor, or an anchor pointing at a commit that no longer exists
  // (rebase, force-push, fresh clone). Recover by reviewing the working tree
  // ONCE, with no range, and adopting the current HEAD.
  //
  // Reviewing everything back to the root commit is the failure this branch
  // exists to avoid, and it is not what this does: with no `revisionRange` the
  // diff tool shows the working tree, which is the pre-axis behaviour and a
  // bounded amount of work. Staying silent was the earlier choice here and it
  // had a cost nobody had priced — a fresh install says nothing at all until
  // the author's first commit.
  if (facts.storedHead === undefined || facts.storedHeadVanished === true) {
    return { fire: true, reason: "anchor_unusable", advanceAnchorTo: here };
  }

  // AC1, AC3 — nothing new. The nudge is the only thing that can happen here.
  if (facts.head === facts.storedHead) {
    return { fire: false, reason: "no_new_commit", nudge: shouldNudge(facts) };
  }

  // AC16 — HEAD moved but the content did not: `commit --amend` of a message,
  // or a rebase that only relocated commits. D3: sameness is decided on the
  // TREE, never the commit id.
  //
  // An anchor written before this field existed (`storedTree` absent) must not
  // read as "unchanged", or the first real review after an upgrade is silently
  // suppressed. That safety comes from `facts.tree` being a string by this
  // point and a string never being `===` to `undefined` — NOT from an explicit
  // guard. There was one here; mutation testing showed deleting it changed
  // nothing, so it was a guard that could not fire, which is the exact species
  // this track exists to remove. The behaviour is covered by the "an anchor
  // written before trees were stored" test, which fails if the comparison is
  // ever loosened (e.g. to `==` or to a nullish-coalesced default).
  if (facts.tree === facts.storedTree) {
    return {
      fire: false,
      reason: "tree_unchanged",
      advanceAnchorTo: here,
      nudge: shouldNudge(facts),
    };
  }

  // AC5 — the PR unit: the whole branch, not the single commit.
  if (facts.unit === "pr" && facts.onDefaultBranch !== true && facts.mergeBase !== undefined) {
    return {
      fire: true,
      reason: "branch_grew",
      revisionRange: `${facts.mergeBase}..${facts.head}`,
      advanceAnchorTo: here,
    };
  }

  // AC2, AC4, AC6 — the commit unit. Also where `pr` lands when there is no
  // branch to diff: committing straight to the default branch is exactly when
  // you want to be told something, so going silent there would be a surprise
  // rather than a design (the maintainer, OQ2).
  const fellBack = facts.unit === "pr";
  return {
    fire: true,
    reason: fellBack ? "pr_fallback_to_commit" : "new_commit",
    revisionRange: `${facts.storedHead}..${facts.head}`,
    advanceAnchorTo: here,
  };
}
