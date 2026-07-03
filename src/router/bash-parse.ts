// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Bash argv parser for file-write detection.
 *
 * Hybrid heuristic: whitelist pattern-match + git snapshot fallback.
 *
 * Uses `shell-quote` (POSIX-safe tokenizer) to split command strings into token
 * streams, then pattern-matches against a whitelist of known file-modifying ops.
 *
 * Pure function: no IO, no spawn, no fs access.
 */

import { parse } from "shell-quote";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BashWriteOp =
  | "sed-i" // sed -i pattern (in-place edit)
  | "redirect" // > FILE  or  >> FILE
  | "heredoc" // <<EOF ... EOF > FILE (or redirect target when <<-combined)
  | "tee" // tee FILE
  | "mv" // mv SRC DST
  | "cp" // cp SRC DST
  | "patch" // patch -p1 < FILE
  | "git-apply" // git apply FILE
  | "formatter" // prettier --write / eslint --fix / cargo fmt / etc.
  | "unknown-write"; // best-effort catchall (recognized command, files unclear)

export type BashWriteOp_Match = {
  op: BashWriteOp;
  files: string[]; // paths as written in the command — caller resolves to absolute
};

// ---------------------------------------------------------------------------
// Internal token types from shell-quote
// ---------------------------------------------------------------------------

type ShellToken = string | { op: string; text?: string };

function isOpToken(t: ShellToken): t is { op: string } {
  return typeof t === "object" && t !== null && "op" in t;
}

function isStringToken(t: ShellToken): t is string {
  return typeof t === "string";
}

// ---------------------------------------------------------------------------
// Splitting helpers
// ---------------------------------------------------------------------------

// Separators that end a command (NOT pipeline — pipelines need special treatment)
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "&"]);

/**
 * Split a flat token array into per-command segments.
 * Pipelines (`|`) are NOT split into separate commands here — instead, the
 * entire pipeline is treated as one segment, and we rely on `parseSegment`
 * recognising that only the LAST pipe stage can write (via redirect/tee).
 */
function splitIntoSegments(tokens: ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];

  for (const tok of tokens) {
    if (isOpToken(tok) && COMMAND_SEPARATORS.has(tok.op)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    } else {
      current.push(tok);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * When a segment contains `|`, split into pipe stages and return only the
 * last stage (the stage that can write to a file).
 */
function lastPipeStage(segment: ShellToken[]): ShellToken[] {
  let lastSplit = 0;
  for (let i = 0; i < segment.length; i++) {
    const tok = segment[i];
    if (tok !== undefined && isOpToken(tok) && tok.op === "|") {
      lastSplit = i + 1;
    }
  }
  return segment.slice(lastSplit);
}

// ---------------------------------------------------------------------------
// Segment parsers
// ---------------------------------------------------------------------------

/**
 * Return the positional (non-flag, non-op) string tokens within a segment.
 * Starts from `startIdx` (default 1, to skip the command name).
 */
function positionals(stage: ShellToken[], startIdx = 1): string[] {
  return stage
    .slice(startIdx)
    .filter(isStringToken)
    .filter((t) => !t.startsWith("-"));
}

/** Find the token immediately after a given op in the token list. */
function tokenAfterOp(
  stage: ShellToken[],
  opName: string,
): string | undefined {
  for (let i = 0; i < stage.length - 1; i++) {
    const tok = stage[i];
    if (tok !== undefined && isOpToken(tok) && tok.op === opName) {
      const next = stage[i + 1];
      if (next !== undefined && isStringToken(next)) return next;
    }
  }
  return undefined;
}

/** True if any op token with the given name exists in the stage. */
function hasOp(stage: ShellToken[], opName: string): boolean {
  return stage.some((t) => isOpToken(t) && t.op === opName);
}

/** True if any op token with the given name exists in the FULL segment (pre-pipe-split). */
function segmentHasOp(segment: ShellToken[], opName: string): boolean {
  return segment.some((t) => isOpToken(t) && t.op === opName);
}

// ---------------------------------------------------------------------------
// Per-binary matchers
// ---------------------------------------------------------------------------

function parseSed(stage: ShellToken[]): BashWriteOp_Match | null {
  // sed -i [''] SCRIPT FILE...
  // The file is the last positional argument that doesn't start with '-'.
  // We skip the sed script (which looks like 's/foo/bar/g') heuristically —
  // scripts contain '/', flags start with '-', empty backup '' is just ''.
  const args = stage.slice(1).filter(isStringToken); // all string tokens after 'sed'
  // Find '-i' flag
  if (!args.includes("-i")) return null;

  // Collect positionals that are neither flags nor look like sed scripts.
  // A sed script typically contains '/', or is quoted. We consider anything
  // that contains '/' (but isn't a path-like) or is preceded by '-i' a script.
  // Simpler heuristic: the last arg that doesn't start with '-' and doesn't
  // contain '/' (unless it looks like a path) is the file. We take the LAST
  // non-flag arg and treat it as the file.
  const nonFlags = args.filter((a) => !a.startsWith("-"));
  // If empty backup '' is present, remove it (it's the -i '' idiom)
  const withoutEmpty = nonFlags.filter((a) => a !== "");
  // The file is the last element; everything before it up to the first script-like
  // token is the script. For simplicity, use the last positional as the file.
  const file = withoutEmpty[withoutEmpty.length - 1];
  if (!file) return null;
  return { op: "sed-i", files: [file] };
}

function parseRedirectsAndHeredoc(
  stage: ShellToken[],
  fullSegment: ShellToken[],
): BashWriteOp_Match | null {
  // Heredoc detection: if the FULL segment (pre-pipe-split) has << op tokens,
  // and there is also a > redirect, call it heredoc with the redirect target.
  const hasHeredoc = segmentHasOp(fullSegment, "<<");
  const redirectTarget =
    tokenAfterOp(stage, ">") ?? tokenAfterOp(stage, ">>");
  const hasRedirect = hasOp(stage, ">") || hasOp(stage, ">>");

  if (!hasRedirect) return null;

  if (hasHeredoc && redirectTarget) {
    return { op: "heredoc", files: [redirectTarget] };
  }
  if (redirectTarget) {
    return { op: "redirect", files: [redirectTarget] };
  }
  return null;
}

function parseTee(stage: ShellToken[]): BashWriteOp_Match | null {
  const pos = positionals(stage);
  return { op: "tee", files: pos };
}

function parseMv(stage: ShellToken[]): BashWriteOp_Match | null {
  const pos = positionals(stage);
  if (pos.length < 2) return null;
  return { op: "mv", files: [pos[0]!, pos[pos.length - 1]!] };
}

function parseCp(stage: ShellToken[]): BashWriteOp_Match | null {
  const pos = positionals(stage);
  if (pos.length < 2) return null;
  return { op: "cp", files: [pos[0]!, pos[pos.length - 1]!] };
}

function parsePatch(stage: ShellToken[]): BashWriteOp_Match | null {
  // patch -p1 < FILE  or  patch FILE  or  patch -p1 FILE
  // Prefer stdin redirect target; fall back to last positional.
  const stdinTarget = tokenAfterOp(stage, "<");
  if (stdinTarget) return { op: "patch", files: [stdinTarget] };
  const pos = positionals(stage);
  if (pos.length > 0) return { op: "patch", files: [pos[pos.length - 1]!] };
  return { op: "patch", files: [] };
}

function parseGitApply(stage: ShellToken[]): BashWriteOp_Match | null {
  // git apply FILE
  const args = stage.slice(1).filter(isStringToken);
  // args[0] === 'apply'
  if (args[0] !== "apply") return null;
  const pos = args.slice(1).filter((a) => !a.startsWith("-"));
  return { op: "git-apply", files: pos };
}

/** Formatters that are purely write-ops (no read-only mode needed). */
function parseFormatter(stage: ShellToken[]): BashWriteOp_Match | null {
  const bin = stage[0];
  if (!isStringToken(bin)) return null;

  const args = stage.slice(1).filter(isStringToken);

  switch (bin) {
    case "prettier": {
      if (!args.includes("--write")) return null;
      const files = args.filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    case "eslint": {
      if (!args.includes("--fix")) return null;
      const files = args.filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    case "cargo": {
      if (args[0] !== "fmt") return null;
      // cargo fmt formats everything; no explicit files
      return { op: "formatter", files: [] };
    }
    case "gofmt": {
      if (!args.includes("-w")) return null;
      const files = args.filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    case "ruff": {
      if (args[0] !== "format") return null;
      const files = args.slice(1).filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    case "biome": {
      if (args[0] !== "format") return null;
      const files = args.slice(1).filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    case "dprint": {
      if (args[0] !== "fmt") return null;
      const files = args.slice(1).filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    case "stylua": {
      const files = args.filter((a) => !a.startsWith("-"));
      return { op: "formatter", files };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Segment-level dispatcher
// ---------------------------------------------------------------------------

function parseSegment(
  segment: ShellToken[],
): BashWriteOp_Match[] {
  const stage = lastPipeStage(segment);
  const results: BashWriteOp_Match[] = [];

  const bin = stage.find(isStringToken);
  if (!bin) {
    // No command name — check for bare redirects (e.g. a pipeline stage that's
    // just a redirect). Handled below.
  }

  // Redirect / heredoc detection applies to any stage that has > or >> ops.
  // Do this first because it can co-exist with a command name.
  const redirectMatch = parseRedirectsAndHeredoc(stage, segment);
  if (redirectMatch) {
    results.push(redirectMatch);
    return results; // redirect wins over any further matching on the same stage
  }

  if (!bin) return results;

  switch (bin) {
    case "sed": {
      const m = parseSed(stage);
      if (m) results.push(m);
      break;
    }
    case "tee": {
      const m = parseTee(stage);
      if (m) results.push(m);
      break;
    }
    case "mv": {
      const m = parseMv(stage);
      if (m) results.push(m);
      break;
    }
    case "cp": {
      const m = parseCp(stage);
      if (m) results.push(m);
      break;
    }
    case "patch": {
      const m = parsePatch(stage);
      if (m) results.push(m);
      break;
    }
    case "git": {
      const m = parseGitApply(stage);
      if (m) results.push(m);
      break;
    }
    case "prettier":
    case "eslint":
    case "cargo":
    case "gofmt":
    case "ruff":
    case "biome":
    case "dprint":
    case "stylua": {
      const m = parseFormatter(stage);
      if (m) results.push(m);
      break;
    }
    default:
      break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Bash command string and return any detected file-modifying operations.
 *
 * Best-effort: returns [] for commands that don't match any whitelist pattern.
 * Handles command chains (A && B, A || B, A ; B) by parsing each sub-command.
 * Handles pipelines weakly: only the LAST stage of a pipeline is considered
 * for writes (earlier stages pipe to next stage's stdin, not to files).
 *
 * Pure function: no IO, no spawn, no fs access.
 *
 * @param command - Raw Bash command string (from tool_input.command)
 * @returns Array of matched write operations (empty if none detected)
 */
export function parseBashCommandForFileWrites(
  command: string,
): BashWriteOp_Match[] {
  if (!command.trim()) return [];

  let tokens: ShellToken[];
  try {
    tokens = parse(command) as ShellToken[];
  } catch {
    return [];
  }

  // Guard: if parse returned only op tokens (e.g. ">>>"), nothing useful
  const hasAnyString = tokens.some(isStringToken);
  const hasOnlyOps = !hasAnyString && tokens.length > 0;
  if (hasOnlyOps) return [];

  const segments = splitIntoSegments(tokens);
  const results: BashWriteOp_Match[] = [];

  for (const seg of segments) {
    const matches = parseSegment(seg);
    results.push(...matches);
  }

  return results;
}
