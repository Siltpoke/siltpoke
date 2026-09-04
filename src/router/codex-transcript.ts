// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Codex rollout transcript adapter.
 *
 * codex-cli writes session transcripts as JSONL "rollout" files where every
 * line is a {timestamp, type, payload} envelope (types: session_meta,
 * turn_context, response_item, event_msg) — a different schema from the
 * Claude Code transcript that the router's extractors were built for.
 * Verified against a real codex-cli 0.142.5 rollout (2026-07-07 host-
 * integration smoke): without translation, extractChangedFiles() sees zero
 * changed files and the Stop pipeline skips every Codex turn as
 * "no_code_changes".
 *
 * This module maps Codex envelope lines onto the internal TranscriptEvent
 * shape at the single readEvents() chokepoint, so extractChangedFiles /
 * extractLatestUserMessage / extractTranscriptTurns work on both formats
 * unchanged:
 *
 * - event_msg/user_message      → user text turn
 * - event_msg/agent_message     → assistant text turn
 * - event_msg/patch_apply_end   → assistant tool_use per changed file
 *                                 (add → Write, update/delete → Edit;
 *                                 payload.changes keys are absolute paths)
 * - everything else             → dropped (response_item duplicates the
 *                                 event_msg content and would double-count)
 *
 * Deliberately NOT handled yet: shell-command file writes (Codex
 * function_call events). Codex applies file edits through apply_patch, so
 * patch_apply_end covers the dominant path; command-driven writes are a
 * follow-up once a real transcript exhibits them.
 */
import type { TranscriptEvent } from "./context";

const CODEX_ENVELOPE_TYPES = new Set([
  "session_meta",
  "turn_context",
  "response_item",
  "event_msg",
]);

interface CodexEnvelope {
  type: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

function asCodexEnvelope(ev: unknown): CodexEnvelope | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: unknown; payload?: unknown };
  if (typeof e.type !== "string" || !CODEX_ENVELOPE_TYPES.has(e.type)) {
    return null;
  }
  if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) {
    return null;
  }
  return ev as CodexEnvelope;
}

function textTurn(
  role: "user" | "assistant",
  text: string,
  timestamp?: string,
): TranscriptEvent {
  return { type: role, message: { role, content: text }, timestamp };
}

function patchApplyToToolUses(
  payload: Record<string, unknown>,
  timestamp?: string,
): TranscriptEvent[] {
  if (payload.success === false) return [];
  const changes = payload.changes;
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return [];
  }
  const parts: { type: "tool_use"; name: string; input: { file_path: string } }[] = [];
  for (const [path, change] of Object.entries(changes)) {
    if (!path) continue;
    const kind =
      typeof change === "object" && change !== null
        ? (change as { type?: unknown }).type
        : undefined;
    parts.push({
      type: "tool_use",
      name: kind === "add" ? "Write" : "Edit",
      input: { file_path: path },
    });
  }
  if (parts.length === 0) return [];
  return [
    {
      type: "assistant",
      message: { role: "assistant", content: parts },
      timestamp,
    },
  ];
}

/**
 * Normalize one parsed transcript line.
 *
 * Returns null when the line is NOT a Codex rollout envelope (caller keeps
 * the original event untouched — Claude passthrough), or an array of 0..n
 * mapped TranscriptEvents when it is.
 */
export function normalizeCodexEvents(ev: unknown): TranscriptEvent[] | null {
  const envelope = asCodexEnvelope(ev);
  if (!envelope) return null;

  if (envelope.type !== "event_msg") return [];

  const payload = envelope.payload;
  const kind = payload.type;
  const ts = envelope.timestamp;

  if (kind === "user_message" && typeof payload.message === "string") {
    return payload.message.trim() ? [textTurn("user", payload.message, ts)] : [];
  }
  if (kind === "agent_message" && typeof payload.message === "string") {
    return payload.message.trim() ? [textTurn("assistant", payload.message, ts)] : [];
  }
  if (kind === "patch_apply_end") {
    return patchApplyToToolUses(payload, ts);
  }
  return [];
}
