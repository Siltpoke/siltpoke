// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { normalizeAntigravityEvents } from "./antigravity-transcript";
import { parseBashCommandForFileWrites } from "./bash-parse";
import { normalizeCodebuddyEvents } from "./codebuddy-transcript";
import { normalizeCodexEvents } from "./codex-transcript";
import { diffAgainstBaseline, type GitBaseline } from "./git-snapshot";
import { resolveInsideRepo } from "../utils/repo-path";

export interface ContextBundle {
  text: string;
  turns_included: number;
  session_id: string;
  cwd: string;
}

export interface PackagerInput {
  session_id: string;
  cwd: string;
  transcript_path: string;
  maxTurns?: number;
}

/**
 * Options for widened extractChangedFiles().
 *
 * Path normalization policy: paths are emitted as-is from each source.
 * - Edit/Write/MultiEdit/NotebookEdit: paths as written in tool_use input
 *   (often absolute, but may be relative when the LLM chose a relative path).
 * - parseBashCommandForFileWrites: relative (as written in the command).
 * - diffAgainstBaseline: relative-to-cwd (as reported by git status).
 * Downstream consumers resolve them via `cwd`.
 * We deliberately do NOT normalize here — a single normalization pass at the
 * callsite (with the real cwd) is more correct than a speculative join here.
 */
export interface ExtractChangedFilesOpts {
  /** Working directory; required when gitBaseline is provided. */
  cwd?: string;
  /**
   * Git baseline captured at session start (via captureGitBaseline).
   * - Non-null: diff against current git status and union result.
   * - null: cwd is not a git repo; whitelist-only (console.error warning logged).
   * - undefined / omitted: skip git-snapshot entirely.
   */
  gitBaseline?: GitBaseline | null;
  /**
   * Drop paths that no longer exist on disk before returning. The transcript is
   * append-only, so a file Edit'd then renamed/deleted within the same session
   * still surfaces its OLD path — which then trips downstream rules (e.g. the
   * critic's kebab-case convention) on a file that is already gone. Off by
   * default to keep the extractor a pure transcript parser; production callers
   * (Stop hook) opt in. Verifiable only when a path resolves (absolute, or
   * relative + cwd); unverifiable relatives are kept (never drop on doubt).
   */
  pruneMissing?: boolean;
  /**
   * Drop paths that do not resolve inside `cwd`. The transcript names every
   * path a tool touched, so a `> /tmp/build.log` redirect, a scratchpad script
   * under /private/tmp, `/dev/null`, and stale paths from a pre-migration repo
   * root all arrive here looking exactly like source edits. Measured over the
   * 125 August critiques in this repo, 1264 of 2086 changed_files entries (60%)
   * were repo-external and 124 of 125 critiques carried at least one — and they
   * are not inert: the god-file rubric fired on a 9915-line /tmp build log and
   * that finding became the critique's anchors[0], which the acted-on oracle
   * could then never read (permanent `file_unreadable` abstain).
   *
   * Off by default to keep the extractor a pure transcript parser; the Stop
   * hook opts in. Requires `cwd` — without one nothing is dropped, matching
   * `pruneMissing`'s never-drop-on-doubt rule. Filters only: a kept path is
   * returned in the form the transcript wrote it, because downstream consumers
   * (rubric, evidence corpus, anchors) read those exact strings.
   */
  confineToCwd?: boolean;
}

export interface TranscriptEvent {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
  timestamp?: string;
  [key: string]: unknown;
}

function safeJsonParse<T = TranscriptEvent>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

const FILE_CHANGE_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

interface ToolUsePart {
  type: "tool_use";
  name?: string;
  input?: { file_path?: unknown; path?: unknown; command?: unknown };
}

export async function readEvents(
  transcriptPath: string,
): Promise<TranscriptEvent[]> {
  if (!existsSync(transcriptPath)) return [];
  try {
    const raw = await readFile(transcriptPath, "utf8");
    return raw
      .split("\n")
      .map((l) => safeJsonParse(l))
      .filter((e): e is TranscriptEvent => e !== null)
      .flatMap(
        (e) =>
          normalizeCodexEvents(e) ??
          normalizeAntigravityEvents(e) ??
          normalizeCodebuddyEvents(e) ??
          [e],
      );
  } catch {
    return [];
  }
}

/**
 * Deduplicate and sort a union of path arrays.
 * Skips empty strings — parseBashCommandForFileWrites may emit "" for formatters
 * with no explicit file list (e.g. `cargo fmt` with files: []).
 */
function unionPaths(...sources: string[][]): string[] {
  const seen = new Set<string>();
  for (const paths of sources) {
    for (const p of paths) {
      if (p) seen.add(p);
    }
  }
  return [...seen].sort();
}

/**
 * Drop changed-file paths that no longer exist on disk. The transcript is an
 * append-only history: a file Edit'd then later renamed or deleted within the
 * same session still appears as a tool_use, so its OLD path leaks into the
 * changed-file set and downstream rules (e.g. critic's kebab-case convention)
 * flag a file that is already gone.
 *
 * The SAME file can appear as BOTH an absolute path (Edit/Write tool_use) AND a
 * relative one (parseBashCommandForFileWrites parses `sed`/`grep` argv) — so
 * verifying only absolute paths leaves the relative twin behind and the stale
 * finding survives. We resolve relative paths against `cwd` when we have one;
 * only a relative path with NO cwd is unverifiable → kept (never drop on doubt).
 */
/**
 * Drop changed-file paths that do not resolve inside `cwd` — see
 * `ExtractChangedFilesOpts.confineToCwd` for what gets in and why.
 *
 * FAIL-SAFE: if confinement would remove EVERY path, none are removed. An empty
 * changed-file set makes the critic review nothing, silently — and a cwd that
 * contains none of the session's edits is far more likely a wrong cwd than a
 * session that genuinely only touched /tmp. agy `-p` is the known case: its
 * payload carries no workspacePaths, so `event.cwd` falls back to the host's
 * own config directory. There, silencing the review outright would be a worse
 * failure than the repo-external noise this filter exists to remove.
 *
 * Residual, stated rather than assumed: containment is decided on resolved
 * paths, NOT realpath'd ones, so a cwd and an edit expressed through different
 * symlinks to the same directory (macOS /tmp vs /private/tmp) read as
 * different roots. That case lands in the fail-safe — no filtering, a logged
 * warning — rather than in a wrong verdict.
 */
export function confineToRepo(paths: string[], cwd: string): string[] {
  const inside = paths.filter((p) => resolveInsideRepo(cwd, p) !== null);
  if (paths.length > 0 && inside.length === 0) {
    console.error(
      `[siltpoke] every changed file resolved outside cwd (${cwd}) — keeping all ${paths.length}; cwd is probably wrong`,
    );
    return paths;
  }
  return inside;
}

function pruneMissingPaths(paths: string[], cwd?: string): string[] {
  return paths.filter((p) => {
    if (isAbsolute(p)) return existsSync(p);
    if (cwd) return existsSync(join(cwd, p));
    return true; // relative + no cwd → cannot verify, keep
  });
}

/**
 * Bash tool_use — parse command string for file-write ops.
 * INTENTIONAL: Bash detection runs unconditionally (no opts needed) — it
 * requires no I/O. Only the git-snapshot UNION requires opts.gitBaseline/cwd.
 * Callers that omit opts now also get Bash-detected paths.
 */
function collectBashWritePaths(command: string, out: string[]): void {
  try {
    const matches = parseBashCommandForFileWrites(command);
    for (const match of matches) {
      for (const file of match.files) {
        if (file) out.push(file);
      }
    }
  } catch {
    // parseBashCommandForFileWrites is a pure function and shouldn't throw,
    // but if it does, degrade gracefully.
  }
}

/** Extract a changed-file path (if any) from a single assistant content part. */
function collectPathsFromPart(part: unknown, out: string[]): void {
  if (
    typeof part !== "object" ||
    part === null ||
    (part as { type?: string }).type !== "tool_use"
  ) {
    return;
  }
  const tp = part as ToolUsePart;
  if (!tp.name) return;

  if (FILE_CHANGE_TOOLS.has(tp.name)) {
    // Edit / Write / MultiEdit / NotebookEdit — extract file_path or path
    const path =
      (typeof tp.input?.file_path === "string" && tp.input.file_path) ||
      (typeof tp.input?.path === "string" && tp.input.path);
    if (path) out.push(path);
    return;
  }

  if (tp.name === "Bash") {
    const command = typeof tp.input?.command === "string" ? tp.input.command : "";
    if (command) collectBashWritePaths(command, out);
  }
}

/** Scan every assistant turn's tool_use parts for changed-file paths. */
function collectToolUsePaths(events: TranscriptEvent[]): string[] {
  const transcriptPaths: string[] = [];
  for (const ev of events) {
    const role = ev.type ?? ev.role ?? ev.message?.role;
    if (role !== "assistant") continue;
    const content = (ev.message?.content ?? ev.content) as unknown;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      collectPathsFromPart(part, transcriptPaths);
    }
  }
  return transcriptPaths;
}

/**
 * Resolve the final changed-file list per ExtractChangedFilesOpts: union
 * with the git-snapshot diff when a baseline is available, apply
 * pruneMissing, and log the same telemetry warnings as before.
 */
async function finalizeChangedFiles(
  transcriptPaths: string[],
  opts?: ExtractChangedFilesOpts,
): Promise<string[]> {
  // When no opts provided, return transcript-only result (backwards-compat).
  if (!opts) {
    return unionPaths(transcriptPaths);
  }

  const { cwd, gitBaseline, pruneMissing, confineToCwd } = opts;
  const finish = (paths: string[]): string[] => {
    // Confinement runs FIRST: a repo-external path is not merely stale, and
    // pruneMissing would keep any that happen to exist on disk (/tmp/build.log
    // does exist — that is exactly how it reached the rubric).
    const confined = confineToCwd && cwd ? confineToRepo(paths, cwd) : paths;
    return pruneMissing ? pruneMissingPaths(confined, cwd) : confined;
  };

  // gitBaseline is explicitly null → non-git session; whitelist-only with warning.
  if (gitBaseline === null) {
    console.error(
      "[siltpoke] non-git session, Bash detection via whitelist only",
    );
    return finish(unionPaths(transcriptPaths));
  }

  // gitBaseline provided (non-null) + cwd → union with git-snapshot diff.
  if (gitBaseline !== undefined && cwd) {
    let snapshotPaths: string[] = [];
    try {
      snapshotPaths = await diffAgainstBaseline(gitBaseline, cwd);
    } catch {
      // diffAgainstBaseline returns [] on failure, but be defensive anyway.
    }
    return finish(unionPaths(transcriptPaths, snapshotPaths));
  }

  // Invalid call: gitBaseline provided but cwd missing — surface as telemetry
  // warning so the caller knows the snapshot was silently dropped. JSDoc on
  // ExtractChangedFilesOpts marks cwd as required when gitBaseline is provided.
  if (gitBaseline !== undefined && !cwd) {
    console.error(
      "[siltpoke] gitBaseline provided without cwd — git-snapshot skipped",
    );
  }

  // opts provided but no gitBaseline (undefined) or no cwd → transcript-only.
  return finish(unionPaths(transcriptPaths));
}

export async function extractChangedFiles(
  transcriptPath: string,
  opts?: ExtractChangedFilesOpts,
): Promise<string[]> {
  const events = await readEvents(transcriptPath);
  const transcriptPaths = collectToolUsePaths(events);
  return finalizeChangedFiles(transcriptPaths, opts);
}

export async function extractLatestUserMessage(
  transcriptPath: string,
): Promise<string> {
  const events = await readEvents(transcriptPath);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    const role = ev.type ?? ev.role ?? ev.message?.role;
    if (role !== "user") continue;
    const content = (ev.message?.content ?? ev.content) as unknown;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (p): p is { type: string; text?: string } =>
            typeof p === "object" &&
            p !== null &&
            (p as { type?: string }).type === "text",
        )
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function summarizeToolUse(part: { type: string; name?: unknown; input?: unknown }): string {
  const name = typeof part.name === "string" ? part.name : "tool";
  const input = (typeof part.input === "object" && part.input !== null
    ? part.input
    : {}) as Record<string, unknown>;
  const fp =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    "";
  if (name === "Bash" && typeof input.command === "string") {
    const cmd = input.command.slice(0, 160).replace(/\s+/g, " ");
    return `[tool ${name}] ${cmd}`;
  }
  if (fp) return `[tool ${name}] ${fp}`;
  // Fallback: surface tool name only so Brain sees that tool work happened.
  return `[tool ${name}]`;
}

export function extractUserText(ev: TranscriptEvent): string | null {
  const content = (ev.message?.content ?? ev.content) as unknown;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (p): p is { type: string; text?: string } =>
        typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

export function extractAssistantText(ev: TranscriptEvent): string | null {
  const msg = (ev.message ?? ev) as { content?: unknown };
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  // Include BOTH text parts AND tool_use summaries. Pre-fix this function
  // stripped tool_use parts, so turns made entirely of Edit/Write/Bash
  // (very common in agent sessions) collapsed to empty strings and got
  // filtered out by packContext — leading Brain to reply "no code".
  const parts = c.filter(
    (part): part is { type: string; text?: string; name?: unknown; input?: unknown } =>
      typeof part === "object" && part !== null && "type" in part,
  );
  const pieces: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      pieces.push(part.text);
    } else if (part.type === "tool_use") {
      pieces.push(summarizeToolUse(part));
    }
  }
  const joined = pieces.join("\n");
  return joined.length > 0 ? joined : null;
}

export interface TurnRecord {
  index: number;
  userAsk: string;
  editedFiles: string[];
  timestamp: string | null;
}

/**
 * User-prompt text for a single event, or "" for a tool_result-only user
 * event. Mirrors extractLatestUserMessage's text-block filter, but scoped to
 * one event rather than scanning backwards through the whole transcript.
 */
function userPromptText(ev: TranscriptEvent): string {
  const content = (ev.message?.content ?? ev.content) as unknown;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: string; text?: string } =>
          typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
      )
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

interface OpenTurn {
  userAsk: string;
  timestamp: string | null;
  files: string[];
}

/**
 * Structure a transcript into per-user-prompt turns.
 *
 * A turn OPENS on a real user prompt (a user-role event whose content has a
 * text block, or is a non-empty string). A tool_result-only user event
 * (content is an array of tool_result blocks, no text) does NOT open a new
 * turn and does NOT wipe the currently open ask. Every assistant event's
 * tool_use edited-files accumulate into the currently-open turn (deduped via
 * a Set), so a multi-Edit assistant reply is one turn, not one-per-edit. A
 * turn is emitted only if it accumulated >= 1 edited file.
 */
export function extractTurnsFromEvents(events: TranscriptEvent[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  let open: OpenTurn | null = null;

  const flush = (): void => {
    if (open && open.files.length > 0) {
      turns.push({
        index: turns.length,
        userAsk: open.userAsk,
        editedFiles: [...new Set(open.files)],
        timestamp: open.timestamp,
      });
    }
    open = null;
  };

  for (const ev of events) {
    const role = ev.type ?? ev.role ?? ev.message?.role;

    if (role === "user") {
      const ask = userPromptText(ev);
      if (ask.length > 0) {
        flush();
        open = { userAsk: ask, timestamp: ev.timestamp ?? null, files: [] };
      }
      // tool_result-only user event: neither opens a turn nor wipes the ask.
      continue;
    }

    if (role === "assistant" && open) {
      const content = (ev.message?.content ?? ev.content) as unknown;
      if (Array.isArray(content)) {
        for (const part of content) collectPathsFromPart(part, open.files);
      }
      if (open.timestamp === null && typeof ev.timestamp === "string") {
        open.timestamp = ev.timestamp;
      }
    }
  }

  flush();
  return turns;
}

export async function extractTurns(transcriptPath: string): Promise<TurnRecord[]> {
  return extractTurnsFromEvents(await readEvents(transcriptPath));
}

export const DEFAULT_MAX_TRANSCRIPT_TURNS = 3;

export async function packContext(
  input: PackagerInput,
): Promise<ContextBundle> {
  const max = input.maxTurns ?? DEFAULT_MAX_TRANSCRIPT_TURNS;

  if (!existsSync(input.transcript_path)) {
    return {
      text: `<transcript>\n(no transcript file at ${input.transcript_path})\n</transcript>`,
      turns_included: 0,
      session_id: input.session_id,
      cwd: input.cwd,
    };
  }

  let raw: string;
  try {
    raw = await readFile(input.transcript_path, "utf8");
  } catch (err) {
    return {
      text: `<transcript>\n(failed to read: ${err})\n</transcript>`,
      turns_included: 0,
      session_id: input.session_id,
      cwd: input.cwd,
    };
  }

  const events = raw
    .split("\n")
    .map((l) => safeJsonParse(l))
    .filter((e): e is TranscriptEvent => e !== null);
  const assistantEvents = events.filter(
    (e) => e.type === "assistant" || e.role === "assistant",
  );
  const lastN = assistantEvents.slice(-max);

  const turns = lastN
    .map(extractAssistantText)
    .filter((t): t is string => t !== null && t.length > 0);

  const text = [
    `<session id="${input.session_id}" cwd="${input.cwd}">`,
    `<transcript turns="${turns.length}">`,
    turns
      .map((t, i) => `<turn n="${i + 1}">\n${t.slice(0, 4000)}\n</turn>`)
      .join("\n"),
    `</transcript>`,
    `<task>`,
    `Review the conversation above and produce one Siltpoke JSON. Cite file:line evidence when possible. If unsure, severity=info.`,
    `</task>`,
    `</session>`,
  ].join("\n");

  return {
    text,
    turns_included: turns.length,
    session_id: input.session_id,
    cwd: input.cwd,
  };
}
