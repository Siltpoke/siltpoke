// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat-signal loader for memory consolidation.
 *
 * Reads the developer's chat conversations as a third consolidation input
 * stream (alongside critiques + feedback), so durable facts can be distilled
 * automatically. A write-boundary secret filter drops credential-bearing lines
 * BEFORE they reach the summarizer — in code, not via a prompt (research: a
 * stated exclusion is not an enforced one).
 */

import { listSessions, readSession } from "../chat/jsonl-store";
import type { ChatMessage } from "../chat/schema";

// Obvious secret/credential shapes. Minimal + conservative — a fuller PII
// module is future work. Each pattern anchors to a credential token, not
// generic words, to avoid false positives on ordinary chat.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9-]{16,}/, // OpenAI / Anthropic keys (sk-..., sk-ant-...)
  /\bBearer\s+[A-Za-z0-9._-]{16,}/, // bearer tokens
  /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?\S{6,}/i, // key=value
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  // PII at the same write-boundary drop lane. Home paths leak the
  // username + machine layout. Matches the /Users/<seg> or /home/<seg> prefix
  // shape; relative repo paths and bare system paths (/usr/local/bin, /etc/hosts)
  // carry no identity and survive. CONSERVATIVE by design: this ALSO fires on a
  // URL sub-path like /home/page (no identity, but dropped anyway) — over-drop is
  // the safe failure mode for a PII boundary; the lost message's signal is
  // recoverable from a later message. NOT identity-only despite the prefix shape.
  /(?:\/Users\/|\/home\/)[^/\s]+/, // *nix home paths: /Users/<x>, /home/<x>
  /[A-Za-z]:\\Users\\[^\\\s]+/, // Windows home paths: C:\Users\<x>
  // Narrow RFC-ish email: local@domain.tld. Names alone never match (no @).
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

const CHAT_CAP = 30;

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export async function loadRecentChatMessages(
  homeBase: string,
  sinceTime: Date,
): Promise<string[]> {
  const sessions = await listSessions(homeBase);
  const collected: ChatMessage[] = [];

  for (const { session_id } of sessions) {
    const msgs = await readSession(homeBase, session_id);
    for (const m of msgs) {
      // Only user/assistant carry conversational signal; skip system/tool_result.
      if (m.role !== "user" && m.role !== "assistant") continue;
      const ts = new Date(m.ts);
      if (Number.isNaN(ts.getTime()) || ts <= sinceTime) continue;
      if (containsSecret(m.content)) continue; // write-boundary secret filter
      collected.push(m);
    }
  }

  collected.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()); // newest-first
  return collected.slice(0, CHAT_CAP).map((m) => `[${m.role}] ${m.content.trim()}`);
}
