// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../spawn";
import { adaptiveHunkBody } from "./diff-summarizer";
import {
  formatReviewSubjectBlock,
  type ReviewSubject,
  splitRecentCommitsLog,
} from "./review-subject";
import type { GitDiffHunk, ToolResult, ToolStatus } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

// Hunk header pattern: @@ -oldStart,oldLines +newStart,newLines @@
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Raw hunk data before adaptive body processing. */
interface RawHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  bodyLines: string[];
}

/**
 * Parse a unified diff into raw hunks (body lines untruncated).
 * Truncation/elision is applied afterward via adaptiveHunkBody.
 */
function parseUnifiedDiffRaw(stdout: string): RawHunk[] {
  const lines = stdout.split("\n");
  const hunks: RawHunk[] = [];

  let currentFile = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // New file header: +++ b/<file>
    const newFileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (newFileMatch) {
      currentFile = newFileMatch[1]!;
      i++;
      continue;
    }

    // Hunk header
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch && currentFile !== "") {
      const oldStart = parseInt(hunkMatch[1]!, 10);
      const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3]!, 10);
      const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      const header = line;

      // Collect body lines until next hunk or diff header
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        // Stop at next hunk header, new diff file, or diff --git header
        if (HUNK_HEADER_RE.test(bodyLine) || /^diff --git/.test(bodyLine) || /^--- /.test(bodyLine) || /^\+\+\+ /.test(bodyLine)) {
          break;
        }
        bodyLines.push(bodyLine);
        i++;
      }

      hunks.push({ file: currentFile, oldStart, oldLines, newStart, newLines, header, bodyLines });
      continue;
    }

    i++;
  }

  return hunks;
}

/**
 * Convert raw hunks to GitDiffHunk[] by applying adaptiveHunkBody to each body.
 * Replaces the old fixed MAX_BODY_LINES=30 head-truncation with a three-tier
 * adaptive strategy (full / head+tail elide / LLM summary + head+tail).
 */
async function applyAdaptiveBodies(rawHunks: RawHunk[]): Promise<GitDiffHunk[]> {
  return Promise.all(
    rawHunks.map(async (h) => {
      const rawBody = h.bodyLines.join("\n");
      const body = await adaptiveHunkBody(rawBody);
      return { file: h.file, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, header: h.header, body };
    }),
  );
}

/**
 * Parse raw unified-diff text into `GitDiffHunk[]` with the same per-hunk
 * adaptive truncation (`adaptiveHunkBody`) production applies after `git
 * diff` returns. Exported so callers that already have diff TEXT in hand
 * (no cwd/git subprocess to spawn — e.g. `src/eval/moat/arm.ts`, which reads
 * a diff out of a fixture rather than a live repo) can reuse the exact
 * production parsing/truncation instead of reimplementing it.
 */
export async function parseUnifiedDiff(stdout: string): Promise<GitDiffHunk[]> {
  const raw = parseUnifiedDiffRaw(stdout);
  return applyAdaptiveBodies(raw);
}

function buildRaw(stdout: string, stderr: string): string {
  if (stderr.trim().length === 0) return stdout;
  return `${stdout}\n--- stderr ---\n${stderr}`;
}

/** Allowlist for revisionRange values — prevents option injection via git argv.
 * First char must NOT be `-` to block leading-dash flag injection (e.g. --no-pager). */
const REVISION_RANGE_RE = /^[A-Za-z0-9._^~:/][A-Za-z0-9._^~:/-]*$/;

/**
 * The ref whose tree is on the NEW side of a revision range.
 *
 * Exported for its own test rather than left inline, because the rule is not
 * obvious and the wrong version is silent: `src/cli/review.ts` builds a
 * THREE-dot `base...HEAD`, and splitting on the FIRST `..` yields `.HEAD`,
 * which resolves to nothing. Every such review would then be treated as
 * unanchored and lose its line numbers, with no error anywhere to say why.
 * Both `A..B` and `A...B` put B's tree on the new side.
 */
export function rangeRightSide(revisionRange: string): string {
  const sep = revisionRange.lastIndexOf("..");
  return sep === -1 ? revisionRange.trim() : revisionRange.slice(sep + 2).trim();
}

/**
 * Whether the `+` side of the diff we are about to hand the reviewer is the
 * file as it sits on disk right now.
 *
 * It matters because a line number is only useful if the reader can open the
 * file and find the code there. `git diff HEAD` compares against the working
 * tree, so its `+` side IS the disk and the answer is yes. A range compares two
 * commits, and its `+` side is the disk only when the right-hand side resolves
 * to HEAD and nothing is uncommitted.
 *
 * FAILS CLOSED. Every error, timeout, or unparseable answer returns false, and
 * the caller then writes a provenance tier with no line number rather than a
 * number nothing verified.
 */
async function computeRangesAnchored(
  cwd: string,
  revisionRange: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  // Same test the argv construction above uses: a blank string is "no range".
  // Three places used to ask this question three ways; they now agree.
  if (revisionRange === undefined || revisionRange.trim() === "") return true;

  const rightSide = rangeRightSide(revisionRange);
  if (rightSide === "") return false;

  try {
    const [right, head, dirty] = await Promise.all([
      spawnWithTimeout({ argv: ["git", "rev-parse", rightSide], cwd, timeoutMs }),
      spawnWithTimeout({ argv: ["git", "rev-parse", "HEAD"], cwd, timeoutMs }),
      spawnWithTimeout({ argv: ["git", "diff", "--quiet", "HEAD"], cwd, timeoutMs }),
    ]);
    if (right.timedOut || head.timedOut || dirty.timedOut) return false;
    if (right.exitCode !== 0 || head.exitCode !== 0) return false;
    const sameCommit = right.stdout.trim() !== "" && right.stdout.trim() === head.stdout.trim();
    // `--quiet` exits 0 when there is nothing to report and 1 when there is.
    return sameCommit && dirty.exitCode === 0;
  } catch {
    return false;
  }
}

export async function runGitDiff(opts: {
  cwd: string;
  revisionRange?: string;
  timeoutMs?: number;
  /**
   * Test-only affordance: override the spawned argv entirely. Used by the timeout
   * test to inject a deliberately-slow command (e.g. ["sleep", "10"]) since git
   * itself is too fast to reliably trip a small timeoutMs on CI. Not exposed to
   * production callers; underscore-prefixed signals test-only.
   */
  _argv?: string[];
}): Promise<Extract<ToolResult, { tool: "git-diff" }>> {
  const { cwd, revisionRange, timeoutMs = DEFAULT_TIMEOUT_MS, _argv } = opts;

  // Validate revisionRange before spawning — reject anything outside the safe allowlist.
  if (revisionRange !== undefined && revisionRange.trim() !== "") {
    if (!REVISION_RANGE_RE.test(revisionRange)) {
      return {
        tool: "git-diff",
        status: "error",
        parsed: [],
        raw: "invalid revision range",
      };
    }
  }

  let argv: string[];
  if (_argv !== undefined) {
    argv = _argv;
  } else {
    argv = ["git", "diff"];
    if (revisionRange !== undefined && revisionRange.trim() !== "") {
      argv.push(revisionRange);
    } else {
      argv.push("HEAD");
    }
    argv.push("--no-color");
  }

  const result = await spawnWithTimeout({ argv, cwd, timeoutMs });
  const raw = buildRaw(result.stdout, result.stderr);

  if (result.timedOut) {
    return { tool: "git-diff", status: "timeout", parsed: [], raw };
  }

  // Non-git cwd or git not installed: git exits non-zero.
  // Check stderr patterns first (most specific), then fall back to ENOENT heuristic.
  if (result.exitCode !== 0) {
    // "fatal: not a git repository" → not_applicable (git is present, dir is not a repo)
    const stderrLower = result.stderr.toLowerCase();
    const isNotGitRepo =
      stderrLower.includes("not a git repository") ||
      result.stderr.includes("fatal:");
    if (isNotGitRepo) {
      return { tool: "git-diff", status: "not_applicable", parsed: [], raw };
    }

    // ENOENT: spawn succeeded but git binary not found — empty stdout AND stderr
    const isEnoent = result.stdout.trim() === "" && result.stderr.trim() === "";
    if (isEnoent) {
      return { tool: "git-diff", status: "not_installed", parsed: [], raw };
    }

    return { tool: "git-diff", status: "error", parsed: [], raw };
  }

  let parsed: GitDiffHunk[];
  try {
    parsed = await parseUnifiedDiff(result.stdout);
  } catch {
    return { tool: "git-diff", status: "error", parsed: [], raw };
  }

  const status: ToolStatus = "ok";
  const rangesAnchored = await computeRangesAnchored(cwd, revisionRange, timeoutMs);
  return { tool: "git-diff", status, parsed, raw, rangesAnchored };
}

/**
 * Recent-commits fallback. When the working tree is clean,
 * `git diff HEAD` returns empty — but Brain still needs to see what
 * just happened in the session. Returns the last N commits' diffs with every
 * inline commit header stripped, prefixed by the ONE commit that is the review
 * subject (`commit <sha>` + its message, git-shaped, no siltpoke prose), plus the
 * hunks parsed from the stripped body. See ./review-subject.ts for why the headers
 * cannot be left in. `raw` is persisted as the /critic snapshot and replayed to the
 * chat model, so it stays diff-shaped; the human-facing notice is added at prompt
 * assembly by `buildToolOutputSection`, never here.
 * Used by the Stop-hook critic path, NOT by the `review` CLI (which
 * intentionally treats a clean tree as "nothing to review").
 */
export async function runRecentCommitsDiff(opts: {
  cwd: string;
  commitCount?: number;
  timeoutMs?: number;
}): Promise<{
  raw: string;
  parsed: GitDiffHunk[];
  reviewSubject?: ReviewSubject;
  rangesAnchored: boolean;
} | null> {
  const { cwd, commitCount = 3, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const result = await spawnWithTimeout({
    // The three `--*` flags pin the header shape against the adopter's git config:
    // `format.pretty`, `log.abbrevCommit` and `log.showSignature` each reshape it,
    // and a header we fail to recognise is a header we fail to strip — silently
    // restoring the defect in exactly the repos nobody would test.
    // No `--stat`: the per-commit file summary is dropped along with the header it
    // belongs to, and requesting output that is then discarded is pure cost.
    argv: [
      "git", "log", `-${commitCount}`, "--no-color",
      "--pretty=medium", "--no-abbrev-commit", "--no-show-signature",
      "-p", "HEAD",
    ],
    cwd,
    timeoutMs,
  });
  if (result.timedOut || result.exitCode !== 0) return null;
  if (result.stdout.trim().length === 0) return null;

  // Strip every inline commit header and name exactly one review subject, so a
  // scope claim cannot be made against a message that belongs to another commit.
  // See ./review-subject.ts for the mechanism and the two measured false positives.
  const { subject, diffOnly, windowHasMerge } = splitRecentCommitsLog(result.stdout);
  const body = subject === null ? result.stdout : diffOnly;
  // `.citable`, not `.shown`: the notice is siltpoke's own prose, and `raw` is read
  // back as a diff by the /critic snapshot, the chat `diff_text` channel and the
  // Haiku pre-pass — and on the zero-hunk path it enters the evidence corpus
  // unscoped, where prose would be quotable as if a tool had said it.
  const raw = subject === null
    ? result.stdout
    : `${formatReviewSubjectBlock(subject).citable}\n\n${diffOnly}`;

  let parsed: GitDiffHunk[] = [];
  try {
    // Parse the header-free body: `parseUnifiedDiffRaw` does not stop a hunk body
    // at a bare `---`, so parsing the unstripped blob attaches one commit's header
    // to the previous commit's last hunk.
    parsed = await parseUnifiedDiff(body);
  } catch {
    parsed = [];
  }
  // This path is only ever taken on a CLEAN working tree, so the newest commit's
  // `+` side IS the file on disk — unless a merge is in the window. Plain `-p`
  // emits no patch for a merge, so the merge is dropped and the newest block
  // then belongs to an ancestor on one side of it, whose line numbers are
  // relative to that side's parent.
  const rangesAnchored = !windowHasMerge;
  return subject === null
    ? { raw, parsed, rangesAnchored }
    : { raw, parsed, reviewSubject: subject, rangesAnchored };
}
