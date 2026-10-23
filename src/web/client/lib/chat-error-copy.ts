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

/**
 * The three reasons that predate defect [49]. Their copy below is what a user
 * on claude sees, and what any failure with no agent named falls back to.
 */
export type ChatErrorReason = "timeout" | "spawn_failed" | "empty_exit";

/** The five coding agents chat can go to (mirrors the server's ChatProviderName). */
type ChatAgentName = "claude" | "codex" | "agy" | "qoder" | "codebuddy";
const AGENT_NAMES: readonly string[] = ["claude", "codex", "agy", "qoder", "codebuddy"];

/** Who a failure belongs to. Both fields arrive from the wire / the store, so
 * both are `unknown` here and are checked against the five names before use. */
interface ChatErrorWho {
  provider?: unknown;
  found?: unknown;
}

/** Only one of the five names survives. Everything the copy below interpolates
 * went through this — so no server string can reach the page through it. */
export function asAgent(value: unknown): ChatAgentName | undefined {
  return typeof value === "string" && AGENT_NAMES.includes(value) ? (value as ChatAgentName) : undefined;
}

function asAgents(value: unknown): ChatAgentName[] {
  if (!Array.isArray(value)) return [];
  return value.map(asAgent).filter((a): a is ChatAgentName => a !== undefined);
}

export const CHAT_ERROR_COPY: Record<ChatErrorReason, string> = {
  // No duration: each agent has its own time limit (60s claude, 90s most
  // others, 120s codex), so any number here would be wrong for somebody.
  timeout:
    "I waited but my brain never answered. (backend timeout — try sending that again?)",
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

const TO_SETTINGS = "choose another agent on the Settings page";

/**
 * Map a (possibly unknown / absent) reason to its fixed pet-voice copy, naming
 * the agent it belongs to when one is given.
 *
 * With claude — or with no agent named, which is every row stored before [49] —
 * the three original sentences are returned unchanged. Another agent gets the
 * same sentence with its name in it and a pointer to the Settings page, where
 * chat's agent is chosen. A `switch` on the reason, so a prototype-chain key
 * ("toString") lands in the default like any other unknown string.
 */
export function chatErrorCopy(reason: string | null | undefined, who: ChatErrorWho = {}): string {
  const provider = asAgent(who.provider);
  const other = provider !== undefined && provider !== "claude" ? provider : undefined;
  switch (reason) {
    case "timeout":
      return other
        ? `I waited but my brain never answered. (${other} timed out — try again, or ${TO_SETTINGS}.)`
        : CHAT_ERROR_COPY.timeout;
    case "spawn_failed":
      return other
        ? `I couldn't reach my brain at all just now. (couldn't start ${other} — is it installed and logged in? You can ${TO_SETTINGS}.)`
        : CHAT_ERROR_COPY.spawn_failed;
    case "empty_exit":
      return other
        ? `My brain came back with… nothing. (empty response from ${other} — try once more, or ${TO_SETTINGS}.)`
        : CHAT_ERROR_COPY.empty_exit;
    case "provider_failed":
      return `My brain stumbled. (${provider ?? "the agent"} ran and failed — is it logged in? You can ${TO_SETTINGS}.)`;
    case "no_provider":
      return "I have no brain to think with. (no coding-agent command line was found on this machine — install one, then check the Settings page.)";
    case "choose_provider": {
      const found = asAgents(who.found);
      const list = found.length > 0 ? found.join(", ") : "more than one coding agent";
      return `I don't know which brain to use. (found ${list} — choose one for chat on the Settings page.)`;
    }
    case "quota_cap":
      return "I've used up today's calls. (chat reached its daily call cap, which counts every agent — raise the chat cap on the Settings page, or wait until tomorrow.)";
    default:
      return CHAT_ERROR_FALLBACK_COPY;
  }
}

/** What a parsed `error` frame / stored failed row says about a failure. */
interface ChatFailure {
  reason?: string;
  provider?: ChatAgentName;
  found?: ChatAgentName[];
}

/**
 * Parse an SSE `error` frame's data payload into its classified reason and the
 * agent it names. Must be safe on garbage (malformed JSON, non-object payloads,
 * non-string reason fields all yield `{}` → fallback copy downstream). The raw
 * server error string in the frame is deliberately never extracted, and an
 * agent name that is not one of the five is dropped.
 */
export function parseErrorEvent(data: string): ChatFailure {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object") return {};
    const p = parsed as { reason?: unknown; provider?: unknown; found?: unknown };
    if (typeof p.reason !== "string") return {};
    const provider = asAgent(p.provider);
    const found = asAgents(p.found);
    return {
      reason: p.reason,
      ...(provider ? { provider } : {}),
      ...(found.length > 0 ? { found } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The waiting line for an agent whose reply arrives in one piece (AC8), from a
 * `message_start` frame. "" when the frame does not say so — claude streams,
 * and a pre-[49] server sends neither field. Driven by the server's own event,
 * never by a timer.
 */
export function wholeReplyNote(data: string): string {
  try {
    const p = JSON.parse(data) as { provider?: unknown; whole_reply?: unknown } | null;
    if (p === null || typeof p !== "object" || p.whole_reply !== true) return "";
    const provider = asAgent(p.provider);
    return `${provider ?? "this agent"} answers all at once — the reply will appear in one piece`;
  } catch {
    return "";
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
  /** `choose_provider` only: the agents found, offered as buttons to pick from. */
  found?: ChatAgentName[];
}

/**
 * Build a failed-turn transcript entry from an optional classified reason.
 * No reason → fallback copy and NO error_reason key (a classification is
 * never invented for failures that don't carry one).
 */
export function makeFailedEntry(reason?: string, who: ChatErrorWho = {}): FailedChatEntry {
  const found = reason === "choose_provider" ? asAgents(who.found) : [];
  return {
    role: "assistant",
    text: chatErrorCopy(reason, who),
    status: "failed",
    ...(reason ? { error_reason: reason } : {}),
    ...(found.length > 0 ? { found } : {}),
  };
}
