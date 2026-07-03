// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseBashCommandForFileWrites } from "./bash-parse";
import { diffAgainstBaseline, type GitBaseline } from "./git-snapshot";

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

async function readEvents(
  transcriptPath: string,
): Promise<TranscriptEvent[]> {
  if (!existsSync(transcriptPath)) return [];
  try {
    const raw = await readFile(transcriptPath, "utf8");
    return raw
      .split("\n")
      .map((l) => safeJsonParse(l))
      .filter((e): e is TranscriptEvent => e !== null);
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
function pruneMissingPaths(paths: string[], cwd?: string): string[] {
  return paths.filter((p) => {
    if (isAbsolute(p)) return existsSync(p);
    if (cwd) return existsSync(join(cwd, p));
    return true; // relative + no cwd → cannot verify, keep
  });
}

export async function extractChangedFiles(
  transcriptPath: string,
  opts?: ExtractChangedFilesOpts,
): Promise<string[]> {
  const events = await readEvents(transcriptPath);
  const transcriptPaths: string[] = [];

  for (const ev of events) {
    const role = ev.type ?? ev.role ?? ev.message?.role;
    if (role !== "assistant") continue;
    const content = (ev.message?.content ?? ev.content) as unknown;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        typeof part !== "object" ||
        part === null ||
        (part as { type?: string }).type !== "tool_use"
      ) {
        continue;
      }
      const tp = part as ToolUsePart;
      if (!tp.name) continue;

      if (FILE_CHANGE_TOOLS.has(tp.name)) {
        // Edit / Write / MultiEdit / NotebookEdit — extract file_path or path
        const path =
          (typeof tp.input?.file_path === "string" && tp.input.file_path) ||
          (typeof tp.input?.path === "string" && tp.input.path);
        if (path) transcriptPaths.push(path);
      } else if (tp.name === "Bash") {
        // Bash tool_use — parse command string for file-write ops.
        // INTENTIONAL: Bash detection runs unconditionally (no opts needed) — it
        // requires no I/O. Only the git-snapshot UNION requires opts.gitBaseline/cwd.
        // Callers that omit opts now also get Bash-detected paths.
        const command = typeof tp.input?.command === "string" ? tp.input.command : "";
        if (command) {
          try {
            const matches = parseBashCommandForFileWrites(command);
            for (const match of matches) {
              for (const file of match.files) {
                if (file) transcriptPaths.push(file);
              }
            }
          } catch {
            // parseBashCommandForFileWrites is a pure function and shouldn't throw,
            // but if it does, degrade gracefully.
          }
        }
      }
    }
  }

  // When no opts provided, return transcript-only result (backwards-compat).
  if (!opts) {
    return unionPaths(transcriptPaths);
  }

  const { cwd, gitBaseline, pruneMissing } = opts;
  const finish = (paths: string[]): string[] => (pruneMissing ? pruneMissingPaths(paths, cwd) : paths);

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
