// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * chat_sessions[] metadata helpers — keep memory.json in sync with the
 * per-session JSONL stores written by jsonl-store.ts. Single-writer
 * invariant (daemon-mediated only).
 */

import {
  readMemory,
  writeMemory,
  emptyMemory,
  type CoreMemory,
  type ChatSession,
  type ChatAnchor,
} from "../memory/memory";

export interface ChatSessionListItem {
  id: string;
  anchor: ChatAnchor | null;
  label: string;
  pin: string;
  badge: string;
  /** Dropdown title: the conversation's first user message (session.summary),
   *  falling back to the node label when there's no summary yet. */
  title: string;
  message_count: number;
  /** ISO timestamp the conversation was created — drives the history-list
   *  newest-first sort and the per-row "created" label. */
  started_at: string;
  ended_at: string | null;
}

function deriveLabels(anchor: ChatAnchor | null): { label: string; pin: string; badge: string } {
  if (!anchor) return { label: "Chat", pin: "", badge: "" };
  // "critique" anchors are pinned to a fired review, not a graph node — an
  // honest badge beats the node-only fn/file discriminant (which would
  // otherwise fall through to "fn" since node_type is "critique" for these).
  const badge = anchor.kind === "critique" ? "review" : anchor.node_type === "file" ? "file" : "fn";
  return { label: anchor.node_name, pin: anchor.node_name, badge };
}

/** Derive a short conversation title from its first user message. Collapses
 *  whitespace and truncates with an ellipsis. Empty/blank input → "". */
export function chatTitle(message: string, max = 60): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Deterministic $0 extractive placeholder summary. Shown until consolidate
 * writes the real LLM one-liner. Intentionally longer than chatTitle's 60 chars so
 * it reads as a summary, not a title; never "(no summary)".
 */
export function placeholderSummary(firstUserMsg: string, max = 100): string {
  const clean = firstUserMsg.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "(new chat — summary pending)";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

export async function listChatSessions(homeBase: string): Promise<ChatSessionListItem[]> {
  const memory = await readMemory(homeBase);
  if (!memory) return [];
  return [...memory.chat_sessions]
    .sort((a, b) => (b.ended_at ?? b.started_at).localeCompare(a.ended_at ?? a.started_at))
    .map((s) => {
      const labels = deriveLabels(s.anchor);
      return {
        id: s.id,
        anchor: s.anchor,
        ...labels,
        title: s.summary || labels.label,
        message_count: s.message_count,
        started_at: s.started_at,
        ended_at: s.ended_at,
      };
    });
}

export async function deleteChatSession(homeBase: string, sessionId: string): Promise<boolean> {
  const memory = await readMemory(homeBase);
  if (!memory) return false;
  const existed = memory.chat_sessions.some((s) => s.id === sessionId);
  if (existed) {
    await writeMemory(homeBase, {
      ...memory,
      chat_sessions: memory.chat_sessions.filter((s) => s.id !== sessionId),
    });
  }
  return existed;
}

export interface UpsertResult {
  created: boolean;
  message_count: number;
}

/**
 * Increment message_count for an existing chat_sessions entry, or insert a
 * new one. `messagesDelta` defaults to 2 (one user turn = user + assistant
 * messages).
 *
 * `anchor` is applied ONLY on creation (INV1: a conversation's
 * pinned node is immutable except via an explicit re-anchor handler). The
 * existing-session branch preserves `s.anchor` untouched. `summary` (the
 * first user message, used as the history title) is likewise creation-only —
 * later turns leave the original title in place.
 */
export async function upsertChatSession(
  homeBase: string,
  sessionId: string,
  ts: Date,
  messagesDelta = 2,
  anchor: ChatAnchor | null = null,
  summary = "",
): Promise<UpsertResult> {
  const memory = (await readMemory(homeBase)) ?? emptyMemory();
  const iso = ts.toISOString();
  const existing = memory.chat_sessions.find((s) => s.id === sessionId);
  let next: ChatSession[];
  let created: boolean;
  let message_count: number;

  if (existing) {
    created = false;
    message_count = existing.message_count + messagesDelta;
    next = memory.chat_sessions.map((s) =>
      s.id === sessionId
        ? { ...s, message_count, ended_at: iso }
        : s,
    );
  } else {
    created = true;
    message_count = messagesDelta;
    next = [
      ...memory.chat_sessions,
      {
        id: sessionId,
        started_at: iso,
        ended_at: iso,
        message_count,
        summary,
        summary_generated_at: null,
        tags: [],
        anchor,
      },
    ];
  }

  const updated: CoreMemory = { ...memory, chat_sessions: next };
  await writeMemory(homeBase, updated);
  return { created, message_count };
}

/**
 * The ONLY path that mutates a session's anchor after
 * creation (INV1). Updates the anchor metadata in memory.json for the given
 * session. Does NOT touch the message history (JSONL) — the anchor sidecar
 * overwrite is handled by the caller (the PATCH route) via writeAnchorContext.
 *
 * Returns false if the session doesn't exist (caller should 404 gracefully).
 */
export async function reanchorChatSession(
  homeBase: string,
  sessionId: string,
  anchor: ChatAnchor,
): Promise<boolean> {
  const memory = await readMemory(homeBase);
  if (!memory) return false;
  const exists = memory.chat_sessions.some((s) => s.id === sessionId);
  if (!exists) return false;
  const next = memory.chat_sessions.map((s) =>
    s.id === sessionId ? { ...s, anchor } : s,
  );
  await writeMemory(homeBase, { ...memory, chat_sessions: next });
  return true;
}

export interface ChatSessionStats {
  total_sessions: number;
  total_messages: number;
  most_recent_ended_at: string | null;
}

export async function chatSessionStats(
  homeBase: string,
): Promise<ChatSessionStats> {
  const memory = await readMemory(homeBase);
  if (!memory) {
    return {
      total_sessions: 0,
      total_messages: 0,
      most_recent_ended_at: null,
    };
  }
  const total_sessions = memory.chat_sessions.length;
  const total_messages = memory.chat_sessions.reduce(
    (acc, s) => acc + s.message_count,
    0,
  );
  let most_recent_ended_at: string | null = null;
  for (const s of memory.chat_sessions) {
    if (!s.ended_at) continue;
    if (
      most_recent_ended_at === null ||
      s.ended_at > most_recent_ended_at
    ) {
      most_recent_ended_at = s.ended_at;
    }
  }
  return { total_sessions, total_messages, most_recent_ended_at };
}
