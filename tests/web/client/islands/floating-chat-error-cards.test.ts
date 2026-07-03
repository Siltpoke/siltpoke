/**
 * floating-chat error cards — factory tests, no Alpine/DOM.
 *
 * A classified SSE `error` event renders an in-transcript failed entry
 * carrying the fixed reason-mapped pet copy (never the raw server string).
 * History rows with status "failed" load as the same entries — a failed
 * row (content "") must never surface as a blank assistant bubble; rows
 * with status "cancelled" load as the quiet stopped marker.
 *
 * Rendered-card visuals (Tailwind branches in FloatingChat.tsx) are covered by
 * the SSR markup test; this file proves the data-model behavior both the
 * live path and the history path feed into.
 */
import { describe, expect, test } from "bun:test";
import {
  CHAT_ERROR_COPY,
  CHAT_ERROR_FALLBACK_COPY,
  CHAT_STOPPED_MARKER,
} from "../../../../src/web/client/lib/chat-error-copy";
import { makeFloatingChatData } from "../../../../src/web/client/islands/floating-chat";

function sseBody(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

function sseResponse(...chunks: string[]): Response {
  return new Response(sseBody(...chunks), {
    headers: {
      "content-type": "text/event-stream",
      "X-Siltpoke-Session-Id": "s-deadbeef",
    },
  });
}

function delta(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({ text })}\n\n`;
}

function errorEvent(payload: unknown): string {
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** fetch fake for the send() path — every POST /api/chat returns `chunks`. */
function streamFetch(...chunks: string[]): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes("/api/chat/context-preview")) {
      return Response.json({ node: null, page: "/", facts: 0 });
    }
    return sseResponse(...chunks);
  }) as unknown as typeof fetch;
}

function makeIsland(fetchFn: typeof fetch) {
  const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
  d.newConversation();
  return d;
}

describe("live SSE error events render reason-mapped failed entries", () => {
  test("classified reason → failed entry with its fixed copy; error line stays clear", async () => {
    const d = makeIsland(streamFetch(errorEvent({ error: "proc detail", reason: "spawn_failed" })));
    d.draft = "hello";
    await d.send();

    const msgs = d.active()?.messages ?? [];
    const cards = msgs.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_COPY.spawn_failed);
    expect(cards[0]!.error_reason).toBe("spawn_failed");
    // The raw server string must not appear anywhere in the transcript.
    expect(msgs.some((m) => m.text.includes("proc detail"))).toBe(false);
    // Turn-level failure is a card, not the single transport error line.
    expect(d.error).toBeNull();
    expect(d.streaming).toBe(false);
  });

  test("reason-less error event (route-catch shape) → fallback copy", async () => {
    const d = makeIsland(streamFetch(errorEvent({ error: "unclassified" })));
    d.draft = "hello";
    await d.send();

    const cards = (d.active()?.messages ?? []).filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_FALLBACK_COPY);
  });

  test("error after partial deltas → card only, partial text dropped (matches server persistence)", async () => {
    const d = makeIsland(
      streamFetch(delta("half a "), errorEvent({ error: "t", reason: "timeout" })),
    );
    d.draft = "hello";
    await d.send();

    const msgs = d.active()?.messages ?? [];
    expect(msgs.filter((m) => m.role === "assistant" && !m.status)).toHaveLength(0);
    const cards = msgs.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_COPY.timeout);
  });

  test("silent empty stream (no error event) → empty_exit defense card, exactly one", async () => {
    const d = makeIsland(streamFetch("event: message_stop\ndata: {}\n\n"));
    d.draft = "hello";
    await d.send();

    const cards = (d.active()?.messages ?? []).filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_COPY.empty_exit);
    expect(cards[0]!.error_reason).toBe("empty_exit");
    expect(d.error).toBeNull();
  });

  test("transport failure (fetch throws) → single error line with fixed fallback copy", async () => {
    const throwing = (async () => {
      throw new Error("socket reset by peer");
    }) as unknown as typeof fetch;
    const d = makeIsland(throwing);
    d.draft = "hello";
    await d.send();

    expect(d.error).toBe(CHAT_ERROR_FALLBACK_COPY);
    // Raw error internals never rendered.
    expect(d.error).not.toContain("socket");
    // Transport failure precedes any assistant turn — no card appended.
    expect((d.active()?.messages ?? []).filter((m) => m.status === "failed")).toHaveLength(0);
  });

  test("abort rejection (AbortError) → NOT an error: no error line, no card", async () => {
    // A user-initiated stop surfaces as fetch rejecting with a DOMException
    // named AbortError — it must never render failure copy.
    const aborting = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    const d = makeIsland(aborting);
    d.draft = "hello";
    await d.send();

    expect(d.error).toBeNull();
    expect((d.active()?.messages ?? []).filter((m) => m.status === "failed")).toHaveLength(0);
    expect(d.streaming).toBe(false);
  });
});

describe("persisted failed/cancelled turns load as cards, never blank bubbles", () => {
  const SESSION = {
    id: "s-hist",
    anchor: null,
    label: "Chat",
    pin: "",
    badge: "",
    title: "first question",
    message_count: 5,
    started_at: "2026-07-02T10:00:00.000Z",
  };

  /** fetch fake for the history path — routes session-list + messages GETs. */
  function historyFetch(rows: unknown[]): typeof fetch {
    return (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/chat/sessions")) return Response.json({ sessions: [SESSION] });
      if (u.includes("/api/chat/sessions/s-hist/messages")) return Response.json({ messages: rows });
      if (u.includes("/api/chat/search")) return Response.json({ matches: [] });
      return Response.json({});
    }) as unknown as typeof fetch;
  }

  async function loadWithRows(rows: unknown[]) {
    const d = makeFloatingChatData(historyFetch(rows), {
      onGraph: () => false,
      getViewed: () => null,
    });
    await d.loadSessions(); // opens conversations[0] → fetches its messages
    return d;
  }

  test("failed row with reason → card entry with reason copy, not a blank bubble", async () => {
    const d = await loadWithRows([
      { role: "user", text: "first question" },
      { role: "assistant", text: "", status: "failed", error_reason: "timeout", error_message: "hint" },
    ]);
    const msgs = d.active()?.messages ?? [];
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.status).toBe("failed");
    expect(msgs[1]!.text).toBe(CHAT_ERROR_COPY.timeout);
    // The core claim: nothing loads with empty display text.
    expect(msgs.every((m) => m.text.length > 0)).toBe(true);
  });

  test("failed row WITHOUT reason (route-catch persistence) → fallback copy", async () => {
    const d = await loadWithRows([
      { role: "user", text: "q" },
      { role: "assistant", text: "", status: "failed" },
    ]);
    const msgs = d.active()?.messages ?? [];
    expect(msgs[1]!.status).toBe("failed");
    expect(msgs[1]!.text).toBe(CHAT_ERROR_FALLBACK_COPY);
  });

  test("cancelled row → quiet stopped marker, partial content not displayed", async () => {
    const d = await loadWithRows([
      { role: "user", text: "q" },
      { role: "assistant", text: "partial reply the user stopp", status: "cancelled" },
    ]);
    const msgs = d.active()?.messages ?? [];
    expect(msgs[1]!.status).toBe("cancelled");
    expect(msgs[1]!.text).toBe(CHAT_STOPPED_MARKER);
    expect(msgs.some((m) => m.text.includes("partial reply"))).toBe(false);
  });

  test("legacy blank ok row (status-less assistant, empty content) → fallback card", async () => {
    // Pre-hardening stores hold failed turns as status-less ok rows with
    // content "" — they carry NO reason enum, so the fallback copy renders
    // (no classification is invented for them).
    const d = await loadWithRows([
      { role: "user", text: "q asked before the hardening" },
      { role: "assistant", text: "" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "  \n\t " },
    ]);
    const msgs = d.active()?.messages ?? [];
    expect(msgs).toHaveLength(4);
    expect(msgs[1]!.status).toBe("failed");
    expect(msgs[1]!.text).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(msgs[1]!.error_reason).toBeUndefined();
    // whitespace-only content is just as blank
    expect(msgs[3]!.status).toBe("failed");
    expect(msgs[3]!.text).toBe(CHAT_ERROR_FALLBACK_COPY);
    // user rows untouched; zero blank assistant bubbles reach the model
    expect(msgs[0]).toEqual({ role: "user", text: "q asked before the hardening" });
    expect(msgs.filter((m) => m.role === "assistant" && m.text.trim() === "")).toHaveLength(0);
  });

  test("blank USER row stays untouched (legacy-blank mapping is assistant-only)", async () => {
    const d = await loadWithRows([
      { role: "user", text: "" },
      { role: "assistant", text: "a fine answer" },
    ]);
    const msgs = d.active()?.messages ?? [];
    expect(msgs[0]).toEqual({ role: "user", text: "" });
    expect(msgs[0]!.status).toBeUndefined();
  });

  test("ok rows load unchanged alongside failed rows (mixed history)", async () => {
    const d = await loadWithRows([
      { role: "user", text: "q1" },
      { role: "assistant", text: "a fine answer" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "", status: "failed", error_reason: "empty_exit" },
    ]);
    const msgs = d.active()?.messages ?? [];
    expect(msgs).toHaveLength(4);
    expect(msgs[1]).toEqual({ role: "assistant", text: "a fine answer" });
    expect(msgs[3]!.text).toBe(CHAT_ERROR_COPY.empty_exit);
  });
});
