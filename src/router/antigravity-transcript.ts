// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Antigravity CLI (agy) transcript adapter.
 *
 * agy writes each conversation turn as one JSONL line at the path its Stop
 * hook hands us directly (`transcriptPath` — no derivation, see agy-stop.ts).
 * Every line shares a common step envelope
 * {step_index, source, type, status, created_at, ...type-specific fields} —
 * a different schema from both the Claude Code transcript (message/role) and
 * the Codex rollout envelope (timestamp/type/payload) the router's
 * extractors were originally built for. Captured live 2026-07-10 (gap-
 * verification run, an internal design note
 * design.md §2) — the real transcript is committed at
 * tests/fixtures/agy/transcript-code-edit.jsonl.
 *
 * This module maps agy step lines onto the internal TranscriptEvent shape at
 * the single readEvents() chokepoint (src/router/context.ts), so
 * extractChangedFiles / extractLatestUserMessage / extractTranscriptTurns
 * work on Claude, Codex, AND agy transcripts unchanged:
 *
 * - USER_INPUT      -> user text turn (content arrives wrapped in
 *                       <USER_REQUEST>...</USER_REQUEST> plus sibling
 *                       <ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE> blocks
 *                       that are agy bookkeeping, never surfaced)
 * - PLANNER_RESPONSE -> assistant text turn (from `content`, when present)
 *                       AND/OR one tool_use per edit tool_call
 *                       (`write_to_file` -> Write; `replace_file_content` /
 *                       `multi_replace_file_content` -> Edit; path from
 *                       `args.TargetFile`; mirrors patchApplyToToolUses in
 *                       codex-transcript.ts). The Antigravity desktop app
 *                       (2.0.6, captured 2026-09-30) records edits this way —
 *                       structured `replace_file_content`, no CODE_ACTION —
 *                       and without it every desktop turn read as
 *                       "no_code_changes".
 *                       `thinking` is internal agy reasoning, never surfaced.
 * - CODE_ACTION     -> assistant tool_use per edited file, WHEN the prose
 *                       `content` carries the agy 1.1.1 "...changes were made
 *                       by the <tool> tool to: <path>. If relevant..." shape.
 *                       agy 1.1.1 records edits via `replace_file_content`
 *                       with NO structured tool_call — the 2026-07-10
 *                       write_to_file/args.TargetFile path is gone, so this
 *                       prose is the ONLY signal (verified against a real
 *                       agy 1.1.1 transcript, 2026-07-19 host-integration
 *                       smoke: without it extractChangedFiles sees zero
 *                       changed files and every agy turn skips as
 *                       "no_code_changes"). A legacy write_to_file and this
 *                       CODE_ACTION are not expected to co-occur for the same
 *                       edit given known agy formats (1.1.1 stopped emitting
 *                       write_to_file for edits; the pre-1.1.1 CODE_ACTION uses
 *                       the un-matched "Created file" phrasing). If they ever
 *                       did with byte-identical paths, extractChangedFiles's
 *                       Set union would dedupe them.
 * - everything else -> dropped. RUN_COMMAND / VIEW_FILE / LIST_DIRECTORY /
 *                       CHECKPOINT / CONVERSATION_HISTORY carry no
 *                       code-review-relevant content today. GENERIC (desktop
 *                       2.0.6) is a tool-result step; it repeats an edit as
 *                       prose that the PLANNER_RESPONSE tool_call already
 *                       carries, so it is dropped, not parsed.
 *
 * Deliberately NOT handled yet: (1) non-edit structured tool_calls
 * (e.g. `run_command`, `view_file`); (2) the CODE_ACTION "Created file <url> with requested
 * content" new-file phrasing — only the `replace_file_content` edit phrasing
 * has a captured, verified 1.1.1 shape. Follow-ups once a real transcript
 * exhibits them.
 */
import type { TranscriptEvent } from "./context";

const AGY_STEP_TYPES = new Set([
  "USER_INPUT",
  "CONVERSATION_HISTORY",
  "PLANNER_RESPONSE",
  "CODE_ACTION",
  "RUN_COMMAND",
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "CHECKPOINT",
  "GENERIC",
]);

interface AgyToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface AgyStep {
  type: string;
  content?: unknown;
  tool_calls?: AgyToolCall[];
  created_at?: string;
}

function asAgyStep(ev: unknown): AgyStep | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: unknown };
  if (typeof e.type !== "string" || !AGY_STEP_TYPES.has(e.type)) return null;
  return ev as AgyStep;
}

const USER_REQUEST_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;

/**
 * agy wraps the literal user turn in <USER_REQUEST>...</USER_REQUEST>,
 * followed by sibling <ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE> blocks
 * (local time, model-switch notices) that are agy-internal bookkeeping, not
 * something Brain should review as "what did the user ask for". Falls back
 * to the raw (trimmed) content when the wrapper is absent — defensive, not
 * fatal, matching codex-transcript.ts's `.trim()` guards.
 */
function stripUserRequestWrapper(content: string): string {
  const match = USER_REQUEST_RE.exec(content);
  return (match?.[1] ?? content).trim();
}

interface ToolUsePart {
  type: "tool_use";
  name: string;
  input: { file_path: string };
}

/**
 * Structured edit tool_calls → tool_use name. All three carry the edited path
 * in `args.TargetFile`. `replace_file_content` is verified against a real
 * Antigravity desktop 2.0.6 transcript (tests/fixtures/agy/transcript-desktop-
 * replace-file-content.jsonl); `multi_replace_file_content` ships in the same
 * binaries but has not been seen in a captured transcript yet.
 */
const EDIT_TOOL_NAMES: Readonly<Record<string, string>> = {
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
};

/**
 * The agy CLI JSON-encodes every tool_call arg value — `TargetFile` arrives as
 * `"\"/abs/path\""` (28 of 28 CLI transcripts with an edit, surveyed
 * 2026-10-23; fixture tests/fixtures/agy/transcript-cli-quoted-args.jsonl).
 * The desktop app writes the bare path. Decode only a value wrapped in quotes
 * at both ends that parses as a JSON string; anything else is kept as written.
 */
function decodeArg(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

function editToolUses(toolCalls: AgyToolCall[] | undefined): ToolUsePart[] {
  if (!Array.isArray(toolCalls)) return [];
  const parts: ToolUsePart[] = [];
  for (const call of toolCalls) {
    const name =
      typeof call?.name === "string" && Object.hasOwn(EDIT_TOOL_NAMES, call.name)
        ? EDIT_TOOL_NAMES[call.name]
        : undefined;
    if (!name) continue;
    const rawTarget = call.args?.TargetFile;
    if (typeof rawTarget !== "string") continue;
    const targetFile = decodeArg(rawTarget);
    if (targetFile.length === 0) continue;
    parts.push({ type: "tool_use", name, input: { file_path: targetFile } });
  }
  return parts;
}

/**
 * agy 1.1.1 CODE_ACTION prose: "The following changes were made by the
 * <tool> tool to: <path>. If relevant, proactively run terminal commands..."
 * The path is the only edit signal in this format (no structured tool_call).
 * The path is a single non-whitespace run (`\S+?`) — file paths never contain
 * spaces — so it ends at the first whitespace or end-of-string, and the
 * optional `\.?` drops the trailing sentence period so a dotted filename
 * (token.ts) is captured whole (token.ts, not token.ts.). Using `\S+` rather
 * than `.+?` means a missing space before the boilerplate "If" can never let
 * the match run off into the rest of the sentence. Scoped to this phrasing
 * ONLY: the older "Created file <url>" new-file phrasing is not matched (see
 * module doc).
 */
const CODE_ACTION_EDIT_RE =
  /changes were made by the \S+ tool to:\s*(\S+?)\.?(?=\s|$)/gi;

function codeActionToToolUses(content: unknown): ToolUsePart[] {
  if (typeof content !== "string") return [];
  const parts: ToolUsePart[] = [];
  for (const m of content.matchAll(CODE_ACTION_EDIT_RE)) {
    const filePath = m[1]?.trim();
    if (filePath) {
      parts.push({ type: "tool_use", name: "Edit", input: { file_path: filePath } });
    }
  }
  return parts;
}

function plannerResponseToAssistant(
  step: AgyStep,
  timestamp: string | undefined,
): TranscriptEvent[] {
  const parts: ({ type: "text"; text: string } | ToolUsePart)[] = [];
  if (typeof step.content === "string" && step.content.trim().length > 0) {
    parts.push({ type: "text", text: step.content });
  }
  parts.push(...editToolUses(step.tool_calls));
  if (parts.length === 0) return [];
  return [{ type: "assistant", message: { role: "assistant", content: parts }, timestamp }];
}

/**
 * Normalize one parsed transcript line.
 *
 * Returns null when the line is NOT a recognized agy step envelope (caller
 * keeps the original event untouched — Claude/Codex passthrough), or an
 * array of 0..n mapped TranscriptEvents when it is.
 */
export function normalizeAntigravityEvents(ev: unknown): TranscriptEvent[] | null {
  const step = asAgyStep(ev);
  if (!step) return null;

  const timestamp = typeof step.created_at === "string" ? step.created_at : undefined;

  if (step.type === "USER_INPUT") {
    if (typeof step.content !== "string") return [];
    const text = stripUserRequestWrapper(step.content);
    return text
      ? [{ type: "user", message: { role: "user", content: text }, timestamp }]
      : [];
  }

  if (step.type === "PLANNER_RESPONSE") {
    return plannerResponseToAssistant(step, timestamp);
  }

  if (step.type === "CODE_ACTION") {
    const parts = codeActionToToolUses(step.content);
    return parts.length
      ? [{ type: "assistant", message: { role: "assistant", content: parts }, timestamp }]
      : [];
  }

  return [];
}
