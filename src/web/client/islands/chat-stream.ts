// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * chat-stream — Alpine island for /chat SSE conversation.
 *
 * SSE wire format (from /api/chat):
 *   event: content_block_delta
 *   data: {"text":"<token>"}
 *   (blank line)
 *   event: message_stop
 *   data: {"usage":{"input_tokens":N,"output_tokens":N},"full_text":"..."}
 *   (blank line)
 *
 * SSE backpressure coverage:
 *   1. Partial-line buffer carryover — handled via parseSseChunk remainder.
 *   2. Mid-stream cancel — AbortError is swallowed; other errors set this.error.
 *   3. beforeunload abort — init() registers handler; abortController?.abort().
 *
 * Usage: <div x-data="chat-stream">...</div>
 */

import {
  CHAT_ERROR_FALLBACK_COPY,
  CHAT_STOPPED_MARKER,
  makeFailedEntry,
  parseErrorEvent,
} from "../lib/chat-error-copy";
import { parseSseChunk } from "../lib/sse-parse";
import type { StalenessVerdict } from "../../../repo-graph/staleness-verdict";

/**
 * Render a non-fresh {@link StalenessVerdict} into the fixed notice copy the
 * chat transcript shows (headline + the three split counts). `fresh` never
 * reaches here — callers gate on `level !== "fresh"` first. Exported for
 * direct unit-testing.
 */
export function stalenessNoticeText(v: StalenessVerdict): string {
  return `${v.headline} (${v.counts.content_changed} changed · ${v.counts.deleted_still_indexed} deleted · ${v.counts.unindexed_files} unindexed)`;
}

/**
 * The page's resolved proj_hash as a `?repo=` query suffix, read from the
 * `[data-proj-hash]` attribute Layout.tsx sets on the root `<html>` element
 * (per-request project resolution — see src/daemon/project-context.ts). The
 * chat send fetch below appends this so the server-side write-guard resolves
 * the SAME project the page did. "" when unresolved → no query param (the
 * server falls back to its own sticky-pin resolution).
 */
function writeRepoQuery(): string {
  const projHash =
    (typeof document !== "undefined"
      ? document.querySelector("[data-proj-hash]")?.getAttribute("data-proj-hash")
      : null) ?? "";
  return projHash ? `?repo=${projHash}` : "";
}

export interface ChatMessage {
  role: "user" | "assistant";
  /** For failed/cancelled/notice entries this is the FIXED display copy, never "". */
  text: string;
  /** absent = normal turn; "failed" → error card; "cancelled" → quiet marker;
   *  "notice" → quiet info marker (e.g. index-staleness warning) */
  status?: "failed" | "cancelled" | "notice";
  /** classified reason (absent on route-catch failures — copy falls back) */
  error_reason?: string;
}

export interface ChatStreamData {
  messages: ChatMessage[];
  input: string;
  streaming: boolean;
  buffer: string;
  error: string | null;
  sessionId: string;
  abortController: AbortController | null;
  /** @private stored for beforeunload unregistration in destroy() */
  _beforeUnload?: () => void;
  init(): void;
  destroy(): void;
  send(): Promise<void>;
  /**
   * Abort the in-flight turn (the composer's Stop button).
   * send()'s AbortError path appends the quiet cancelled marker; no error
   * copy is ever set for a stop. No-op at idle (abortController null).
   */
  stop(): void;
}

/**
 * Factory for the chat-stream Alpine data object.
 * Exported for direct unit-testing (no Alpine runtime required).
 */
export function makeChatStreamData(
  fetchFn: typeof fetch = fetch,
): ChatStreamData {
  return {
    messages: [] as ChatMessage[],
    input: "",
    streaming: false,
    buffer: "",
    error: null as string | null,
    sessionId: "",
    abortController: null as AbortController | null,

    init() {
      this.sessionId = crypto.randomUUID();
      const handler = () => {
        this.abortController?.abort();
      };
      window.addEventListener("beforeunload", handler);
      // Store cleanup reference on the object so destroy() can remove it.
      this._beforeUnload = handler;
    },

    destroy() {
      if (this._beforeUnload) {
        window.removeEventListener("beforeunload", this._beforeUnload);
      }
    },

    async send() {
      const userText = this.input.trim();
      if (!userText || this.streaming) return;

      this.messages = [...this.messages, { role: "user", text: userText }];
      this.input = "";
      this.error = null;
      this.buffer = "";
      this.streaming = true;
      this.abortController = new AbortController();

      try {
        // Daemon secret — read from the nearest [data-secret] ancestor at
        // call time (same idiom as active-repos.ts / a retired island). The
        // FloatingChat panel (rendered on every page via Layout) always
        // carries one, so this resolves even though /chat's own screen root
        // has no data-secret of its own. Required since POST /api/chat is
        // secret-gated (daemon-hardening security audit, finding 2).
        const secret =
          (typeof document !== "undefined"
            ? document.querySelector("[data-secret]")?.getAttribute("data-secret")
            : null) ?? "";
        const res = await fetchFn(`/api/chat${writeRepoQuery()}`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Siltpoke-Secret": secret },
          body: JSON.stringify({
            session_id: this.sessionId,
            message: userText,
          }),
          signal: this.abortController.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        // Set when the server sends a classified `error` event; the failure
        // renders as an in-transcript card (never the plain error line).
        let failure: { reason?: string } | null = null;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;

          const { events, remainder } = parseSseChunk(
            pending,
            decoder.decode(value, { stream: true }),
          );
          pending = remainder;

          for (const ev of events) {
            if (ev.name === "content_block_delta") {
              try {
                const payload = JSON.parse(ev.data) as { text?: string };
                if (payload.text) {
                  this.buffer += payload.text;
                }
              } catch {
                // Ignore malformed delta — partial JSON is not an error state.
              }
            } else if (ev.name === "message_stop") {
              // Server signals stream complete. The accumulated delta buffer
              // is treated as canonical; full_text is intentionally not used
              // to replace the buffer here (could be used later for buffer
              // reconciliation / corruption checks).
            } else if (ev.name === "error") {
              // The raw server error string is never rendered — only the
              // classified reason maps (via fixed copy) to what the user sees.
              failure = parseErrorEvent(ev.data);
            } else if (ev.name === "staleness") {
              // Index-staleness verdict (see src/daemon/routes/chat.ts —
              // emitted once, right after message_start). `fresh` renders
              // nothing; anything else lands as a quiet in-transcript notice
              // (same `messages` array other event kinds append to) so the
              // dashboard chat user actually sees the drift the server
              // computed — previously parsed then silently dropped here.
              try {
                const verdict = JSON.parse(ev.data) as StalenessVerdict;
                if (verdict.level !== "fresh") {
                  this.messages = [
                    ...this.messages,
                    { role: "assistant", text: stalenessNoticeText(verdict), status: "notice" },
                  ];
                }
              } catch {
                // Malformed staleness payload — non-fatal, mirrors
                // content_block_delta's tolerance of partial/bad JSON.
              }
            }
          }
        }

        if (failure) {
          // Failed turn → in-transcript error card. Any partial buffer is
          // dropped (mirrors the server persisting failed turns with content "").
          this.messages = [...this.messages, makeFailedEntry(failure.reason)];
        } else if (this.buffer.length > 0) {
          this.messages = [
            ...this.messages,
            { role: "assistant", text: this.buffer },
          ];
        } else {
          // Defense: the server always classifies an empty stream as
          // empty_exit, but if the stream ends silently anyway, render the
          // same card — a sent message must never just vanish.
          this.messages = [...this.messages, makeFailedEntry("empty_exit")];
        }
      } catch (err) {
        // Transport-level failure (fetch throw / HTTP non-ok / no body) —
        // before any turn exists. Single error line, fixed fallback copy;
        // raw error internals are never shown.
        if (err instanceof Error) {
          if (err.name !== "AbortError") {
            this.error = CHAT_ERROR_FALLBACK_COPY;
          } else {
            // A stop is a user action, not a failure: quiet
            // cancelled marker, no error copy; the partial buffer is dropped
            // in the finally below (matches the server's cancelled row).
            this.messages = [
              ...this.messages,
              { role: "assistant", text: CHAT_STOPPED_MARKER, status: "cancelled" },
            ];
          }
        } else {
          this.error = CHAT_ERROR_FALLBACK_COPY;
        }
      } finally {
        this.streaming = false;
        this.buffer = "";
        this.abortController = null;
      }
    },

    stop() {
      this.abortController?.abort();
    },
  };
}

// Guard: only register the Alpine component when running in a browser context.
// Tests import `makeChatStreamData` directly and do not need the DOM side-effect.
//
// NOTE: The component is registered as "chatStream" (camelCase) not "chat-stream"
// because Alpine evaluates x-data values as JavaScript expressions, and hyphenated
// identifiers (e.g. chat-stream) are parsed as subtraction (chat - stream) rather
// than property access, causing the component to fail silently.
if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    globalThis.Alpine.data("chatStream", () => makeChatStreamData());
  });
}
