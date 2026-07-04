// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * captureIntent — extract the verbatim last user message + the agent's
 * first reply to it from the Claude Code transcript for a given Stop-hook
 * fire.
 *
 * Powers Block A "WHAT I READ" in the critique audit UI: shows what the
 * user actually typed AND what Claude wrote back, after stripping image
 * pastes / hook-marker blocks / pure tool-use turns.
 *
 * Note: an earlier iteration also captured `agent_restatement` and
 * `agent_reasoning` for an "intent alignment" critic dimension. That
 * pipeline was removed once Claude Code was confirmed to redact thinking
 * plaintext from the transcript JSONL (only the encrypted signature
 * survives). `agent_reply` here is intentionally just the surface text —
 * no verb-pattern judgement, no alignment scoring.
 */

export interface CapturedIntent {
  /** Verbatim last user message before the agent's final turn. null when not found. */
  user_raw_query: string | null;
  /**
   * Verbatim first paragraph of the agent's first reply AFTER the last
   * user turn. null when no text reply was produced (e.g. tool-only turn).
   * Capped at MAX_REPLY_CHARS.
   */
  agent_reply: string | null;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  /** ISO timestamp from transcript entry if present. */
  ts?: string;
}

const MAX_REPLY_CHARS = 1200;

/**
 * Strip non-intent content from a user transcript turn:
 *   - Lines that are only `[Image: source: ...]` markers (Claude Code pastes).
 *   - Lines wrapped in `<user-prompt-submit-hook>...</user-prompt-submit-hook>`
 *     or other `<system-reminder>`-style tags injected by the hook runner.
 *
 * Returns trimmed plain-text content. If nothing meaningful remains, returns "".
 */
function stripUserTurnNoise(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inSystemTag = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      kept.push("");
      continue;
    }
    if (/^\[Image:\s*source:.*\]$/i.test(line)) continue;
    if (/^<(user-prompt-submit-hook|system-reminder)/i.test(line)) {
      inSystemTag = !/<\/(user-prompt-submit-hook|system-reminder)>\s*$/i.test(line);
      continue;
    }
    if (inSystemTag) {
      if (/<\/(user-prompt-submit-hook|system-reminder)>\s*$/i.test(line)) {
        inSystemTag = false;
      }
      continue;
    }
    kept.push(raw);
  }

  return kept.join("\n").trim();
}

/**
 * Extract a clean first reply paragraph from an assistant turn. Skips
 * leading tool-use summary lines (e.g. "[tool Bash] cmd") that
 * extractAssistantText splices in front of any natural prose, so the user
 * sees Claude's actual words, not a tool log header.
 */
function extractFirstReplyParagraph(text: string): string {
  const lines = text.split("\n");
  // Drop leading tool-summary lines like "[tool Bash] ...", "[tool Write] ..."
  let start = 0;
  while (start < lines.length && /^\s*\[tool\s+[A-Za-z]+\]/i.test(lines[start] ?? "")) {
    start++;
  }
  const after = lines.slice(start).join("\n").trim();
  if (after.length === 0) return "";

  // Take the first non-empty paragraph (split on blank lines).
  const paras = after.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paras.length === 0) return "";
  return paras[0]!;
}

export function captureIntent(
  turns: TranscriptTurn[],
  _commitMsg?: string | null,
): CapturedIntent {
  // Step 1: find LAST user turn whose text survives noise-stripping.
  let user_raw_query: string | null = null;
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.role !== "user") continue;
    const cleaned = stripUserTurnNoise(t.text);
    if (cleaned.length === 0) continue;
    user_raw_query = cleaned;
    lastUserIdx = i;
    break;
  }

  // Step 2: walk FORWARD from after the last user turn looking for the
  // first assistant turn whose text has prose (not just tool-use summaries).
  let agent_reply: string | null = null;
  if (lastUserIdx >= 0) {
    for (let i = lastUserIdx + 1; i < turns.length; i++) {
      const t = turns[i]!;
      if (t.role !== "assistant") continue;
      const para = extractFirstReplyParagraph(t.text);
      if (para.length === 0) continue;
      agent_reply = para.slice(0, MAX_REPLY_CHARS);
      break;
    }
  }

  return { user_raw_query, agent_reply };
}
