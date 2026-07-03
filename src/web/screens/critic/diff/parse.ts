// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Diff parser — unified diff (or `git log -p`) → DiffFile[] → Hunk[] → SideRow[].
 *
 * Pure logic only; render lives in ./render.tsx.
 *
 * Extracted from src/web/screens/critic/diff.tsx. The cc
 * reductions on parseDiffFiles (was 40), parseHunks (was 53),
 * alignHunkSides (was 24) come from extracting per-line classifiers
 * (classifyDiffLine, classifyHunkLine) + the dedup loop (mergeFilesByPath).
 */

export interface DiffFile {
  /** Header label, e.g. "src/foo.ts" or "src/foo.ts → src/bar.ts" (rename). */
  path: string;
  additions: number;
  deletions: number;
  /** Raw body for the file's portion of the diff (hunk headers + bodies). */
  body: string;
}

export interface HunkLine {
  /** "ctx" = context (both sides), "del" = old-only, "add" = new-only. */
  kind: "ctx" | "del" | "add";
  text: string;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  header: string;
  lines: HunkLine[];
}

export interface SideRow {
  no: number | null; // line number (null = empty placeholder)
  text: string;
  kind: "ctx" | "del" | "add" | "empty";
}

// ---------------------------------------------------------------------------
// parseDiffFiles
// ---------------------------------------------------------------------------

function pickPath(header: string): string {
  const m = header.match(/^diff --git a\/(\S+) b\/(\S+)/);
  if (!m) return "(unknown)";
  const a = m[1]!;
  const b = m[2]!;
  return a === b ? a : `${a} → ${b}`;
}

function appendBodyLine(current: DiffFile, line: string): void {
  current.body += `${line}\n`;
  if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
  else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
}

/**
 * Merge duplicate paths. `git log -p` returns one block per (commit, file)
 * tuple, so a file edited across 3 commits would otherwise show up 3 times.
 * Group by path, sum additions/deletions, concatenate bodies with a
 * small separator so the user still sees per-commit context.
 */
function mergeFilesByPath(files: DiffFile[]): DiffFile[] {
  const byPath = new Map<string, DiffFile>();
  for (const f of files) {
    const existing = byPath.get(f.path);
    if (existing === undefined) {
      byPath.set(f.path, { ...f });
    } else {
      existing.additions += f.additions;
      existing.deletions += f.deletions;
      existing.body += `\n--- next change to ${f.path} ---\n${f.body}`;
    }
  }
  return Array.from(byPath.values());
}

/**
 * Parse a unified diff (or `git log -p` output) into per-file groups so the
 * renderer can show a github-style summary at the top.
 *
 * Heuristic: split on lines starting with "diff --git " — that's the canonical
 * per-file boundary. For `git log -p` output, lines starting with "commit "
 * become anonymous-file blocks so commit context survives.
 */
interface ParseState {
  out: DiffFile[];
  current: DiffFile | null;
  commitHeader: string[];
}

function pushCurrent(state: ParseState): void {
  if (state.current) state.out.push(state.current);
  state.current = null;
}

function startNewFile(state: ParseState, line: string): void {
  pushCurrent(state);
  const prefix = state.commitHeader.length > 0 ? `${state.commitHeader.join("\n")}\n` : "";
  state.commitHeader = [];
  state.current = { path: pickPath(line), additions: 0, deletions: 0, body: `${prefix + line}\n` };
}

function processDiffLine(state: ParseState, line: string): void {
  if (line.startsWith("commit ")) {
    pushCurrent(state);
    state.commitHeader = [line];
    return;
  }
  if (line.startsWith("diff --git ")) {
    startNewFile(state, line);
    return;
  }
  if (state.current) {
    appendBodyLine(state.current, line);
  } else if (state.commitHeader.length > 0) {
    state.commitHeader.push(line);
  }
}

function appendDanglingCommit(state: ParseState): void {
  if (state.commitHeader.length === 0 || state.out.length > 0) return;
  state.out.push({
    path: "(commit metadata only — no diff)",
    additions: 0,
    deletions: 0,
    body: state.commitHeader.join("\n"),
  });
}

export function parseDiffFiles(text: string): DiffFile[] {
  const state: ParseState = { out: [], current: null, commitHeader: [] };
  for (const line of text.split("\n")) processDiffLine(state, line);
  pushCurrent(state);
  appendDanglingCommit(state);
  return mergeFilesByPath(state.out);
}

// ---------------------------------------------------------------------------
// parseHunks
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isHunkBoundary(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("commit ") ||
    line.startsWith("--- next change")
  );
}

function classifyHunkLine(line: string): HunkLine | null {
  if (line.startsWith("\\")) return null;
  if (line.startsWith("+++") || line.startsWith("---")) return null;
  if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "del", text: line.slice(1) };
  if (line.startsWith(" ")) return { kind: "ctx", text: line.slice(1) };
  if (line.length === 0) return { kind: "ctx", text: "" };
  return { kind: "ctx", text: line };
}

/**
 * Parse the body of a single file's diff into hunks.
 *
 * The body looks like:
 *   diff --git a/foo b/foo
 *   index abc..def 100644
 *   --- a/foo
 *   +++ b/foo
 *   @@ -10,5 +10,6 @@ ctx
 *   - old line
 *   + new line
 *     context
 *
 * Lines before the first `@@` are header noise (commit metadata, file
 * markers) — dropped. `\` lines (e.g. "\ No newline at end of file")
 * are also dropped.
 */
function startHunk(line: string, hm: RegExpMatchArray): Hunk {
  return {
    oldStart: parseInt(hm[1]!, 10),
    newStart: parseInt(hm[2]!, 10),
    header: line,
    lines: [],
  };
}

export function parseHunks(body: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of body.split("\n")) {
    const hm = line.match(HUNK_HEADER_RE);
    if (hm) {
      if (cur) out.push(cur);
      cur = startHunk(line, hm);
      continue;
    }
    if (isHunkBoundary(line)) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const cls = classifyHunkLine(line);
    if (cls) cur.lines.push(cls);
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// alignHunkSides
// ---------------------------------------------------------------------------

interface AlignBufs {
  left: SideRow[];
  right: SideRow[];
  delBuf: string[];
  addBuf: string[];
  leftNo: number;
  rightNo: number;
}

function flushAlignBufs(state: AlignBufs): void {
  const max = Math.max(state.delBuf.length, state.addBuf.length);
  for (let i = 0; i < max; i++) {
    if (i < state.delBuf.length) {
      state.left.push({ no: state.leftNo++, text: state.delBuf[i]!, kind: "del" });
    } else {
      state.left.push({ no: null, text: "", kind: "empty" });
    }
    if (i < state.addBuf.length) {
      state.right.push({ no: state.rightNo++, text: state.addBuf[i]!, kind: "add" });
    } else {
      state.right.push({ no: null, text: "", kind: "empty" });
    }
  }
  state.delBuf = [];
  state.addBuf = [];
}

/**
 * Align an array of HunkLines into two parallel SideRow arrays for the
 * split view. Algorithm: walk through hunk lines, accumulate consecutive
 * `del`s into a left buffer and consecutive `add`s into a right buffer.
 * When a `ctx` hits or we exhaust, flush the buffers side-by-side (pad
 * the shorter side with empty rows) so the columns stay aligned.
 */
export function alignHunkSides(hunk: Hunk): { left: SideRow[]; right: SideRow[] } {
  const state: AlignBufs = {
    left: [],
    right: [],
    delBuf: [],
    addBuf: [],
    leftNo: hunk.oldStart,
    rightNo: hunk.newStart,
  };
  for (const l of hunk.lines) {
    if (l.kind === "del") {
      state.delBuf.push(l.text);
    } else if (l.kind === "add") {
      state.addBuf.push(l.text);
    } else {
      flushAlignBufs(state);
      state.left.push({ no: state.leftNo++, text: l.text, kind: "ctx" });
      state.right.push({ no: state.rightNo++, text: l.text, kind: "ctx" });
    }
  }
  flushAlignBufs(state);
  return { left: state.left, right: state.right };
}
