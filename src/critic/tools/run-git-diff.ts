// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnWithTimeout } from "../spawn";
import type { GitDiffHunk, ToolResult, ToolStatus } from "./types";
import { adaptiveHunkBody } from "./diff-summarizer";

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

async function parseUnifiedDiff(stdout: string): Promise<GitDiffHunk[]> {
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
  return { tool: "git-diff", status, parsed, raw };
}

/**
 * Recent-commits fallback. When the working tree is clean,
 * `git diff HEAD` returns empty — but Brain still needs to see what
 * just happened in the session. Returns `git log -N -p --stat HEAD`
 * output + parsed hunks so Brain has the last N commits as context.
 * Used by the Stop-hook critic path, NOT by the `review` CLI (which
 * intentionally treats a clean tree as "nothing to review").
 */
export async function runRecentCommitsDiff(opts: {
  cwd: string;
  commitCount?: number;
  timeoutMs?: number;
}): Promise<{ raw: string; parsed: GitDiffHunk[] } | null> {
  const { cwd, commitCount = 3, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const result = await spawnWithTimeout({
    argv: ["git", "log", `-${commitCount}`, "--no-color", "-p", "--stat", "HEAD"],
    cwd,
    timeoutMs,
  });
  if (result.timedOut || result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  if (out.length === 0) return null;
  let parsed: GitDiffHunk[] = [];
  try {
    parsed = await parseUnifiedDiff(result.stdout);
  } catch {
    parsed = [];
  }
  return { raw: result.stdout, parsed };
}
