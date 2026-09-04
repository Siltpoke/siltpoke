// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * CodeBuddy session transcript adapter.
 *
 * codebuddy writes an OpenAI-style JSONL transcript — a different schema from
 * the Claude Code transcript the router's extractors were built for:
 *
 * - top-level `message` turns: {type:"message", role, content:[{type:
 *   "input_text"|"output_text", text}]}
 * - tool calls: {type:"function_call", name, arguments:<JSON string>, callId}
 *   plus a {type:"function_call_result", ...} envelope
 *
 * There are NO Claude `tool_use` content blocks. Verified against a real
 * codebuddy 2.119.2 session (2026-07-19 host-integration smoke, session
 * 72066f02): without translation, extractChangedFiles() sees zero changed
 * files and the Stop pipeline skips every codebuddy turn as
 * "no_code_changes" — i.e. siltpoke installs and fires but reviews nothing.
 *
 * This module maps codebuddy lines onto the internal TranscriptEvent shape at
 * the single readEvents() chokepoint, so extractChangedFiles /
 * extractLatestUserMessage / extractTranscriptTurns work on both formats
 * unchanged:
 *
 * - message/user            → user text turn
 * - message/assistant       → assistant text turn
 * - function_call (Edit/     → assistant tool_use per changed file (file path
 *   Write/MultiEdit)           read from the parsed `arguments` JSON)
 * - everything else         → dropped (function_call_result duplicates the
 *                             call; reasoning / file-history-snapshot etc. add
 *                             no changed-file or turn signal)
 *
 * Deliberately NOT handled yet: (1) Bash-driven file writes (codebuddy records
 * these as function_call name="Bash"); (2) NotebookEdit, whose arg key is
 * `notebook_path` (not `file_path`/`path`) — the shared `collectPathsFromPart`
 * in context.ts is blind to it too, so wiring it is a cross-cutting follow-up,
 * not an adapter-local one. The direct edit tools cover the dominant path;
 * these are follow-ups once a real transcript exhibits them — the same scope
 * choice the codex adapter made.
 */
import type { TranscriptEvent } from "./context";

const CODEBUDDY_TYPES = new Set([
  "message",
  "function_call",
  "function_call_result",
  "reasoning",
  "file-history-snapshot",
  "last-prompt",
  "runtime-config",
]);

// Tool names that denote a file mutation whose path lives at `file_path`/
// `path`. codebuddy reuses Claude's tool names verbatim. NotebookEdit is
// intentionally excluded: its arg key is `notebook_path`, which neither this
// adapter nor the shared collectPathsFromPart reads — see the module doc.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

interface CodebuddyEvent {
  type: string;
  role?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  timestamp?: unknown;
}

function asCodebuddyEvent(ev: unknown): CodebuddyEvent | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: unknown };
  if (typeof e.type !== "string" || !CODEBUDDY_TYPES.has(e.type)) return null;
  return ev as CodebuddyEvent;
}

function isoTimestamp(ts: unknown): string | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString();
  if (typeof ts === "string" && ts) return ts;
  return undefined;
}

/** message/{user,assistant} with content[{text}] → a single text turn. */
function messageTurn(ev: CodebuddyEvent): TranscriptEvent[] {
  const role = ev.role;
  if (role !== "user" && role !== "assistant") return [];
  if (!Array.isArray(ev.content)) return [];
  const text = ev.content
    .map((c) =>
      typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : "",
    )
    .join("")
    .trim();
  if (!text) return [];
  return [{ type: role, message: { role, content: text }, timestamp: isoTimestamp(ev.timestamp) }];
}

/** function_call for an edit tool → assistant tool_use with the file path. */
function functionCallToToolUse(ev: CodebuddyEvent): TranscriptEvent[] {
  if (typeof ev.name !== "string" || !EDIT_TOOLS.has(ev.name)) return [];
  if (typeof ev.arguments !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(ev.arguments);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const args = parsed as { file_path?: unknown; path?: unknown };
  const filePath =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path);
  if (!filePath) return [];
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: ev.name, input: { file_path: filePath } }],
      },
      timestamp: isoTimestamp(ev.timestamp),
    },
  ];
}

/**
 * Normalize one parsed transcript line.
 *
 * Returns null when the line is NOT a codebuddy event (caller keeps the
 * original event untouched — Claude passthrough), or an array of 0..n mapped
 * TranscriptEvents when it is.
 */
export function normalizeCodebuddyEvents(ev: unknown): TranscriptEvent[] | null {
  const e = asCodebuddyEvent(ev);
  if (!e) return null;
  if (e.type === "message") return messageTurn(e);
  if (e.type === "function_call") return functionCallToToolUse(e);
  return [];
}
