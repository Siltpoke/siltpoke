// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * chat-error-copy — the single reason→copy map for chat failure cards.
 *
 * Imported by BOTH chat islands (floating-chat + chat-stream) so the two
 * surfaces can never drift. Copy is fixed template text — server-provided
 * error strings are never rendered verbatim (XSS discipline + honest,
 * stable wording).
 */

/** Mirrors the server's classified failure reasons (chatMessageSchema.error_reason). */
export type ChatErrorReason = "timeout" | "spawn_failed" | "empty_exit";

export const CHAT_ERROR_COPY: Record<ChatErrorReason, string> = {
  timeout:
    "I waited a whole minute but my brain never answered. (backend timeout — try sending that again?)",
  spawn_failed:
    "I couldn't reach my brain at all just now. (couldn't start claude — is it installed and logged in?)",
  empty_exit: "My brain came back with… nothing. (empty response — try once more?)",
};

/**
 * Unknown / absent reason. Persisted failed rows written by the route's
 * catch-all carry NO reason enum — the map must tolerate that.
 */
export const CHAT_ERROR_FALLBACK_COPY =
  "Something broke on my side. (unknown error — try again?)";

/** Quiet marker for cancelled turns — a non-error state, never an error card. */
export const CHAT_STOPPED_MARKER = "stopped";

/**
 * Map a (possibly unknown / absent) reason to its fixed pet-voice copy.
 * `Object.hasOwn` guard: prototype-chain keys must not resolve to internals.
 */
export function chatErrorCopy(reason: string | null | undefined): string {
  if (reason && Object.hasOwn(CHAT_ERROR_COPY, reason)) {
    return CHAT_ERROR_COPY[reason as ChatErrorReason];
  }
  return CHAT_ERROR_FALLBACK_COPY;
}

/**
 * Parse an SSE `error` frame's data payload into its classified reason.
 * Must be safe on garbage (malformed JSON, non-object payloads, non-string
 * reason fields all yield `{}` → fallback copy downstream). The raw server
 * error string in the frame is deliberately never extracted.
 */
export function parseErrorEvent(data: string): { reason?: string } {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "reason" in parsed &&
      typeof (parsed as { reason: unknown }).reason === "string"
    ) {
      return { reason: (parsed as { reason: string }).reason };
    }
    return {};
  } catch {
    return {};
  }
}

/** The in-transcript failed-turn entry shape both chat islands append/render. */
export interface FailedChatEntry {
  role: "assistant";
  /** FIXED display copy — never "" and never a raw server string. */
  text: string;
  status: "failed";
  /** present only when the failure carried a classified reason */
  error_reason?: string;
}

/**
 * Build a failed-turn transcript entry from an optional classified reason.
 * No reason → fallback copy and NO error_reason key (a classification is
 * never invented for failures that don't carry one).
 */
export function makeFailedEntry(reason?: string): FailedChatEntry {
  return {
    role: "assistant",
    text: chatErrorCopy(reason),
    status: "failed",
    ...(reason ? { error_reason: reason } : {}),
  };
}
