// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The I/O half of the ⏱ review-trigger-unit decision.
 *
 * Everything here can fail, and none of it may ever throw into the Stop hook —
 * a hook that crashes takes the pet down with it. Every reader returns a typed
 * absence instead, and `decideReviewUnit` treats absence as `not_a_git_repo`
 * (AC14).
 *
 * Kept separate from `review-unit.ts` so the decision tree stays pure and
 * table-testable without a repository. Spec D1/D3/D4.
 */
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnWithTimeout } from "../critic/spawn";
import { atomicWrite } from "../utils/atomic-write";
import { NUDGE_UNCOMMITTED_LINES, type ReviewUnitFacts } from "./review-unit";

/**
 * Git reads here are single `rev-parse` / `merge-base` calls against a local
 * object database — milliseconds, not seconds. The timeout exists so a wedged
 * filesystem or a network-backed worktree cannot hang the hook, not because
 * these calls are expected to be slow.
 */
const GIT_TIMEOUT_MS = 5_000;

/** Candidates tried in order when the remote does not declare a default. */
const DEFAULT_BRANCH_FALLBACKS = ["main", "master"] as const;

export const ANCHOR_FILENAME = "review-anchor.json";

export interface ReviewAnchor {
  head: string;
  tree: string;
  reviewedAt: string;
}

/**
 * `undefined` when the command FAILED; the trimmed stdout otherwise — which may
 * legitimately be the empty string.
 *
 * The distinction is load-bearing and was not obvious: `git diff HEAD
 * --shortstat` prints NOTHING on a clean tree and exits 0. Folding empty output
 * into `undefined` made a clean tree indistinguishable from a git failure, so
 * "you have no uncommitted work" and "I could not find out" became the same
 * answer. Downstream `?? 0` hid the difference in behaviour while the recorded
 * fact stayed wrong — which is precisely the shape this track exists to remove.
 * A fixture test on a clean repo is what caught it.
 *
 * Callers that need non-empty (`rev-parse`, `merge-base`) get it from git's own
 * exit code: those commands fail rather than succeeding silently, and the
 * `--verify --quiet` forms exist for exactly that.
 */
async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await spawnWithTimeout({
      argv: ["git", ...args],
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (r.timedOut || r.exitCode !== 0) return undefined;
    return r.stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Which branch is this repo's trunk?
 *
 * Resolution order, most authoritative first:
 *   1. `refs/remotes/origin/HEAD` — what the remote itself declares.
 *   2. a local `main`, then `master` — the conventional names, checked for
 *      EXISTENCE rather than assumed.
 *   3. give up.
 *
 * `main` is never assumed. A repo whose trunk is `develop` or `trunk` and which
 * has no `origin/HEAD` returns `undefined` here, and the caller degrades to the
 * commit unit rather than diffing against a branch that does not exist. That
 * degradation is visible in the ledger (`pr_fallback_to_commit`), which is the
 * difference between a limitation and a silent lie.
 */
export async function resolveDefaultBranch(cwd: string): Promise<string | undefined> {
  const declared = await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (declared !== undefined && declared.length > 0) {
    // "refs/remotes/origin/main" -> "origin/main"
    const short = declared.replace(/^refs\/remotes\//, "");
    if (short.length > 0) return short;
  }
  for (const name of DEFAULT_BRANCH_FALLBACKS) {
    const resolved = await git(cwd, ["rev-parse", "--verify", "--quiet", name]);
    if (resolved !== undefined && resolved.length > 0) return name;
  }
  return undefined;
}

export function readAnchor(stateBase: string): ReviewAnchor | undefined {
  const path = join(stateBase, ANCHOR_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewAnchor>;
    if (typeof parsed.head !== "string" || parsed.head.length === 0) return undefined;
    return {
      head: parsed.head,
      // A pre-D3 anchor has no tree. Left absent rather than defaulted — see
      // the tree comparison in review-unit.ts for why that matters.
      tree: typeof parsed.tree === "string" ? parsed.tree : "",
      reviewedAt: typeof parsed.reviewedAt === "string" ? parsed.reviewedAt : "",
    };
  } catch {
    // A corrupt anchor is indistinguishable from no anchor, and the recovery is
    // the same (AC15): adopt the current HEAD rather than review all history.
    return undefined;
  }
}

export function writeAnchor(stateBase: string, anchor: ReviewAnchor): void {
  try {
    atomicWrite(join(stateBase, ANCHOR_FILENAME), `${JSON.stringify(anchor, null, 2)}\n`);
  } catch {
    // A hook must not die because state could not be persisted. The cost of
    // failing here is one repeated review, not a crash.
  }
}

/**
 * Gather everything `decideReviewUnit` needs. Returns facts with `head`/`tree`
 * absent when this is not a usable git repo, which the decision reads as
 * `not_a_git_repo`.
 */
/**
 * Caps on the untracked sweep below. Both exist so this can never become the
 * expensive part of a Stop hook: the nudge only needs to know whether the pile
 * is bigger than a threshold in the low hundreds, so counting past these bounds
 * would buy nothing and could cost a lot in a directory full of build output
 * that nobody thought to gitignore.
 */
const UNTRACKED_FILE_CAP = 200;
const UNTRACKED_BYTES_PER_FILE_CAP = 512 * 1024;

/**
 * Lines in files git does not track yet (respecting `.gitignore`).
 *
 * `0` on any failure — this feeds a cosmetic nudge, and a pet that says nothing
 * is a far better failure than a hook that throws.
 */
async function countUntrackedLines(cwd: string): Promise<number> {
  const listed = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (listed === undefined || listed.length === 0) return 0;

  let total = 0;
  const paths = listed.split("\n").filter((p) => p.length > 0).slice(0, UNTRACKED_FILE_CAP);
  for (const rel of paths) {
    try {
      const abs = join(cwd, rel);
      // `statSync` BEFORE `readFileSync`, and that ordering is the whole point
      // of the cap. The first version read the file and then checked its
      // length, so the cap bounded the line-counting and not the read it
      // claimed to bound — a stray core dump or an un-gitignored build
      // artifact was pulled into memory in full, on a Stop hook, exactly in the
      // "directory full of build output" case the file-count cap names. The
      // comment asserted a mechanism the code did not have.
      if (statSync(abs).size > UNTRACKED_BYTES_PER_FILE_CAP) continue;
      // A binary blob has no meaningful "lines".
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue;
      const text = buf.toString("utf8");
      if (text.length === 0) continue;
      total += text.endsWith("\n")
        ? text.split("\n").length - 1
        : text.split("\n").length;
    } catch {
      // Unreadable, vanished between the listing and the read, a symlink to
      // nowhere — none of it is worth a failed hook.
    }
  }
  return total;
}

export async function collectReviewUnitFacts(opts: {
  cwd: string;
  stateBase: string;
  unit: ReviewUnitFacts["unit"];
  now?: Date;
}): Promise<ReviewUnitFacts> {
  const { cwd, stateBase, unit } = opts;
  const now = opts.now ?? new Date();

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const tree = await git(cwd, ["rev-parse", "HEAD^{tree}"]);
  // Emptiness is checked explicitly rather than relied on from `git()`, which
  // now passes empty output through on purpose. An empty head would otherwise
  // build the range `..<sha>` — a string git accepts and reads as
  // `HEAD..<sha>`, i.e. a confidently wrong diff instead of a clean skip.
  if (head === undefined || tree === undefined || head.length === 0 || tree.length === 0) {
    return { unit };
  }

  const anchor = readAnchor(stateBase);

  // An anchor can name a commit this repo no longer has: rebase, force-push, a
  // fresh clone over the same state dir. Asking git to VERIFY it is the whole
  // point — firing on `<vanished>..HEAD` is a diff command that errors, and a
  // gate whose failure mode is an error message is worse than one that says
  // what happened.
  let storedHeadVanished: boolean | undefined;
  if (anchor !== undefined) {
    const resolved = await git(cwd, ["rev-parse", "--verify", "--quiet", `${anchor.head}^{commit}`]);
    storedHeadVanished = resolved === undefined || resolved.length === 0;
  }

  let onDefaultBranch: boolean | undefined;
  let mergeBase: string | undefined;
  if (unit === "pr") {
    const defaultBranch = await resolveDefaultBranch(cwd);
    const current = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (defaultBranch === undefined) {
      // No trunk to compare against. Reported as "on the default branch" so the
      // decision degrades to the commit unit and SAYS it degraded.
      onDefaultBranch = true;
    } else {
      const shortDefault = defaultBranch.replace(/^origin\//, "");
      onDefaultBranch = current === shortDefault || current === defaultBranch;
      if (onDefaultBranch !== true) {
        const base = await git(cwd, ["merge-base", defaultBranch, "HEAD"]);
        // An empty merge-base would build `..<head>`; left absent instead, which
        // the decision reads as "no branch to diff" and reports as a fallback.
        mergeBase = base !== undefined && base.length > 0 ? base : undefined;
      }
    }
  }

  // `diff --shortstat` counts lines the working tree has that HEAD does not —
  // staged and unstaged both. Absent on failure, which reads as 0 and simply
  // does not nudge.
  //
  // It does NOT count untracked files, and that gap is not academic: the most
  // common shape of "a pile of uncommitted work" after an agent session is a
  // set of BRAND NEW files, and `git diff HEAD` cannot see a single line of
  // them. Left alone, the nudge would stay silent in exactly the situation
  // AC13 describes. The first version of this counted only the diff, and the
  // AC13 test — written with an untracked file, because that is what the
  // scenario looks like — is what surfaced it.
  let uncommittedLines: number | undefined;
  const shortstat = await git(cwd, ["diff", "HEAD", "--shortstat"]);
  if (shortstat !== undefined) {
    let total = 0;
    for (const m of shortstat.matchAll(/(\d+) (insertion|deletion)/g)) {
      total += Number(m[1]);
    }
    // Only sweep the untracked side when it could still change the answer.
    // This number feeds exactly one consumer — the quiet-path nudge's
    // threshold — so once the tracked diff alone is past it, the sweep is a
    // filesystem walk whose result cannot matter. This is also what keeps the
    // walk off the hot path in the common "lots of work in flight" case.
    if (total <= NUDGE_UNCOMMITTED_LINES) {
      total += await countUntrackedLines(cwd);
    }
    uncommittedLines = total;
  }

  let minutesSinceLastReview: number | undefined;
  if (anchor !== undefined && anchor.reviewedAt.length > 0) {
    const t = Date.parse(anchor.reviewedAt);
    if (!Number.isNaN(t)) {
      minutesSinceLastReview = Math.max(0, (now.getTime() - t) / 60_000);
    }
  }

  return {
    head,
    tree,
    storedHead: anchor?.head,
    // "" is the pre-D3 "no tree recorded" marker from readAnchor; it must reach
    // the decision as ABSENT, not as an empty string that could match nothing
    // by accident on some future refactor.
    storedTree: anchor !== undefined && anchor.tree.length > 0 ? anchor.tree : undefined,
    storedHeadVanished,
    unit,
    onDefaultBranch,
    mergeBase,
    uncommittedLines,
    minutesSinceLastReview,
  };
}
