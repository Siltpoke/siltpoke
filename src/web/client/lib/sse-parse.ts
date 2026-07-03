// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * sse-parse — pure SSE block parser for the siltpoke stream protocol.
 *
 * The /api/chat SSE wire format is:
 *   event: content_block_delta
 *   data: {"text":"<token>"}
 *   (blank line)
 *
 * Two call sites:
 *   - src/web/client/islands/chat-stream.ts (browser)
 *   - (potentially) src/cli/chat.ts (Node/Bun) — keeps the same logic
 *
 * This module is pure (no I/O, no side effects) so it can be unit-tested
 * without a browser environment.
 */

export interface SseEvent {
  /** The `event:` field value, e.g. "content_block_delta" | "error" | "message_stop" */
  name: string;
  /** The raw `data:` line value (un-parsed). */
  data: string;
}

/**
 * Parse one or more complete SSE events from `pending + chunk`.
 *
 * Returns:
 *   - `events`   — fully-parsed events extracted from the combined string
 *   - `remainder` — leftover bytes that don't form a complete event yet
 *                  (i.e. no trailing `\n\n` found)
 *
 * Partial-line handling: SSE events are separated by `\n\n`. Any bytes
 * after the last complete `\n\n` are returned as `remainder` and must be
 * prepended to the next chunk from the reader. This correctly handles the
 * case where a chunk boundary falls inside a line (e.g. `"data: hel"` /
 * `"lo world\n\n"`).
 */
export function parseSseChunk(
  pending: string,
  chunk: string,
): { events: SseEvent[]; remainder: string } {
  const combined = pending + chunk;
  const events: SseEvent[] = [];
  let cursor = 0;

  for (;;) {
    const sep = combined.indexOf("\n\n", cursor);
    if (sep < 0) break;

    const block = combined.slice(cursor, sep);
    cursor = sep + 2;

    let eventName = "";
    let dataLine = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataLine = line.slice(6);
      }
    }

    if (eventName || dataLine) {
      events.push({ name: eventName, data: dataLine });
    }
  }

  return { events, remainder: combined.slice(cursor) };
}
