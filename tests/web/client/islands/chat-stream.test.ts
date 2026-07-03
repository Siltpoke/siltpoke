/**
 * chat-stream island unit tests — SSE backpressure.
 *
 * Three mandatory scenarios:
 *   partial-line buffer carryover across chunks
 *   mid-stream ReadableStream cancel / throw
 *   beforeunload fires → abortController.abort() called
 *
 * Strategy: import `makeChatStreamData` factory directly and inject a fake
 * `fetchFn`. No Alpine runtime required — no jsdom. Pure logic harness.
 *
 * SSE wire format:
 *   event: content_block_delta\ndata: {"text":"<token>"}\n\n
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { makeChatStreamData } from "../../../../src/web/client/islands/chat-stream";
import {
  CHAT_ERROR_COPY,
  CHAT_ERROR_FALLBACK_COPY,
  CHAT_STOPPED_MARKER,
} from "../../../../src/web/client/lib/chat-error-copy";
import { parseSseChunk } from "../../../../src/web/client/lib/sse-parse";

// bun:test has no stubGlobal/auto-restore; bare `globalThis.window` stubs set
// below must be DELETED (not set to undefined — `typeof` would still see the
// property) or `typeof window` becomes unreliable for every later test file
// in the shared process (pinned by zz-global-restore.canary.test.ts).
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// ─── parseSseChunk unit tests ──────────────────────────────────────────────

describe("parseSseChunk — partial-line buffer", () => {
  it("parses a complete event in one chunk", () => {
    const chunk = "event: content_block_delta\ndata: {\"text\":\"hello\"}\n\n";
    const { events, remainder } = parseSseChunk("", chunk);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("content_block_delta");
    expect(events[0]!.data).toBe('{"text":"hello"}');
    expect(remainder).toBe("");
  });

  it("handles event split across two chunks — carryover", () => {
    // chunk 1 ends mid-event (no trailing \n\n yet)
    const chunk1 = "event: content_block_delta\ndata: {\"text\":\"hel";
    const { events: ev1, remainder: rem1 } = parseSseChunk("", chunk1);
    expect(ev1).toHaveLength(0);
    expect(rem1).toBe(chunk1);

    // chunk 2 completes the event
    const chunk2 = 'lo world"}\n\n';
    const { events: ev2, remainder: rem2 } = parseSseChunk(rem1, chunk2);
    expect(ev2).toHaveLength(1);
    expect(ev2[0]!.name).toBe("content_block_delta");
    expect(JSON.parse(ev2[0]!.data)).toEqual({ text: "hello world" });
    expect(rem2).toBe("");
  });

  it("handles multiple events in one chunk", () => {
    const chunk =
      "event: content_block_delta\ndata: {\"text\":\"A\"}\n\n" +
      "event: content_block_delta\ndata: {\"text\":\"B\"}\n\n";
    const { events, remainder } = parseSseChunk("", chunk);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!.data).text).toBe("A");
    expect(JSON.parse(events[1]!.data).text).toBe("B");
    expect(remainder).toBe("");
  });

  it("retains trailing partial event as remainder", () => {
    const chunk = "event: content_block_delta\ndata: {\"text\":\"A\"}\n\nevent: me";
    const { events, remainder } = parseSseChunk("", chunk);
    expect(events).toHaveLength(1);
    expect(remainder).toBe("event: me");
  });
});

// ─── makeChatStreamData scenarios ──────────────────────────────────────────

/**
 * Build a ReadableStream from an array of string chunks.
 * Each chunk is delivered as a UTF-8 encoded Uint8Array.
 */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]!));
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Build a fake Response with a ReadableStream body.
 */
function makeResponse(
  chunks: string[],
  status = 200,
): Response {
  return new Response(makeStream(chunks), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Build a fake Response whose stream throws after the first chunk.
 */
function makeErrorStream(firstChunk: string, errMsg: string): Response {
  const encoder = new TextEncoder();
  let yielded = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!yielded) {
        yielded = true;
        controller.enqueue(encoder.encode(firstChunk));
      } else {
        controller.error(new Error(errMsg));
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("partial-line buffer carryover in send()", () => {
  it("accumulates buffer correctly when data splits across chunk boundaries", async () => {
    // Three chunks: data split as "data: hel" / 'lo "}\n\n'
    // SSE format: event + data + blank line
    const chunk1 = "event: content_block_delta\ndata: {\"text\":\"hel";
    const chunk2 = 'lo ';
    const chunk3 = 'world"}\n\n';

    const fakeFetch = mock(() =>
      Promise.resolve(makeResponse([chunk1, chunk2, chunk3])),
    );

    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    // Stub window for beforeunload registration
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    island.init();
    island.input = "hello";

    await island.send();

    expect(island.streaming).toBe(false);
    expect(island.error).toBeNull();
    // Final assistant message should have "hello world"
    const assistant = island.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.text).toBe("hello world");
  });

  it("does not emit partial token prematurely — buffer waits for full event block", async () => {
    // Single chunk with the "data:" line cut off mid-way; no \n\n yet.
    // The reader finishes after this (done=true) — leftover is discarded harmlessly.
    const chunk = "event: content_block_delta\ndata: {\"text\":\"partial";
    // No trailing \n\n → the event block never closes → no text extracted.

    const fakeFetch = mock(() =>
      Promise.resolve(makeResponse([chunk])),
    );
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    island.init();
    island.input = "q";

    await island.send();

    expect(island.streaming).toBe(false);
    // No complete event → no NORMAL assistant bubble pushed. (The empty
    // stream now yields an empty_exit defense CARD, not a plain bubble.)
    const assistant = island.messages.find((m) => m.role === "assistant" && !m.status);
    expect(assistant).toBeUndefined();
  });
});

describe("mid-stream cancel / error", () => {
  it("sets error state when stream throws a non-abort error", async () => {
    const firstChunk = "event: content_block_delta\ndata: {\"text\":\"hi\"}\n\n";
    const fakeFetch = mock(() =>
      Promise.resolve(makeErrorStream(firstChunk, "network blip")),
    );

    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    island.init();
    island.input = "test";

    // Should not throw
    await expect(island.send()).resolves.toBeUndefined();

    expect(island.streaming).toBe(false);
    // Transport-level failures render the single error line with FIXED
    // fallback copy — raw error internals are never shown to the user.
    expect(island.error).toBe(CHAT_ERROR_FALLBACK_COPY);
  });

  it("does NOT set error state on AbortError (user-initiated cancel)", async () => {
    const abortController = { signal: {} as AbortSignal, abort: () => {} };
    let rejectFetch!: (e: Error) => void;

    const fakeFetch = mock(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );

    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    island.init();
    island.input = "test";

    const sendPromise = island.send();

    // Simulate abort
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    rejectFetch(abortErr);

    await sendPromise;

    expect(island.streaming).toBe(false);
    expect(island.error).toBeNull();

    void abortController; // suppress unused warning
  });

  it("flips streaming to false after mid-stream error", async () => {
    const fakeFetch = mock(() =>
      Promise.resolve(makeErrorStream("", "boom")),
    );

    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    island.init();
    island.input = "x";

    await island.send();

    expect(island.streaming).toBe(false);
  });
});

describe("beforeunload fires → abortController.abort()", () => {
  it("calls abortController.abort() when beforeunload fires during stream", async () => {
    let abortCalled = false;
    const fakeAbortController = {
      signal: {} as AbortSignal,
      abort() {
        abortCalled = true;
      },
    };

    // Capture the beforeunload handler so we can invoke it directly.
    let capturedHandler: (() => void) | null = null;
    const fakeWindow = {
      addEventListener(_event: string, handler: () => void) {
        capturedHandler = handler;
      },
      removeEventListener(_event: string, _handler: () => void) {},
    };

    (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;

    // Never-resolving fetch so island stays in streaming state.
    const fakeFetch = mock(() => new Promise<Response>(() => {}));

    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();

    // Inject our fake abort controller BEFORE firing beforeunload.
    island.abortController = fakeAbortController as unknown as AbortController;

    // Fire the beforeunload handler directly (mirrors window.dispatchEvent).
    expect(capturedHandler).not.toBeNull();
    capturedHandler!();

    expect(abortCalled).toBe(true);
  });

  it("does not throw if abortController is null when beforeunload fires", () => {
    let capturedHandler: (() => void) | null = null;
    const fakeWindow = {
      addEventListener(_event: string, handler: () => void) {
        capturedHandler = handler;
      },
      removeEventListener(_event: string, _handler: () => void) {},
    };

    (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
    const fakeFetch = mock(() => new Promise<Response>(() => {}));

    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();

    // abortController is null at idle
    expect(island.abortController).toBeNull();
    // Should not throw
    expect(() => capturedHandler!()).not.toThrow();
  });
});

describe("chat-stream send() — general contract", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  it("pushes user message to messages before fetch", async () => {
    const fakeFetch = mock(() =>
      Promise.resolve(makeResponse([])),
    );
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "hello";
    const sendPromise = island.send();
    // User message is pushed synchronously at the start of send()
    expect(island.messages.some((m) => m.role === "user" && m.text === "hello")).toBe(true);
    await sendPromise;
  });

  it("clears input after send()", async () => {
    const fakeFetch = mock(() =>
      Promise.resolve(makeResponse([])),
    );
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "hello";
    await island.send();
    expect(island.input).toBe("");
  });

  it("does nothing when input is blank", async () => {
    const fakeFetch = mock(() => Promise.resolve(makeResponse([])));
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "   ";
    await island.send();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("does nothing when already streaming", async () => {
    const fakeFetch = mock(() => Promise.resolve(makeResponse([])));
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.streaming = true;
    island.input = "hi";
    await island.send();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("empty stream renders an empty_exit error CARD, not a bubble", async () => {
    // Backend bug: returns message_start + message_stop with usage stats but
    // no content_block_delta events between them. The server now always
    // classifies this, but the client keeps a defense: the silent-empty
    // stream maps to a failed entry with empty_exit copy.
    const startStop = [
      'event: message_start\ndata: {"message_id":"x","model":"claude"}\n\n',
      'event: message_stop\ndata: {"full_text":"","usage":{"input_tokens":1,"output_tokens":0}}\n\n',
    ];
    const fakeFetch = mock(() => Promise.resolve(makeResponse(startStop)));
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "hello";
    await island.send();
    // No plain error line — the failure lives IN the transcript as a card.
    expect(island.error).toBeNull();
    const cards = island.messages.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_COPY.empty_exit);
    expect(cards[0]!.error_reason).toBe("empty_exit");
    // No blank NORMAL assistant bubble appended.
    expect(island.messages.filter((m) => m.role === "assistant" && !m.status)).toHaveLength(0);
    expect(island.streaming).toBe(false);
  });

  // Non-Error thrown values → fixed fallback copy on the error line
  it("sets fallback copy when a non-Error value is thrown (transport failure)", async () => {
    // fetchFn throws a plain string (not an Error instance)
    const fakeFetch = mock(() => Promise.reject("string error"));
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "hi";
    await island.send();
    expect(island.error).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(island.streaming).toBe(false);
  });

  // event:error must not be shadowed by the empty-buffer defense
  it("event:error yields ONE card; the empty-buffer defense does not double-fire", async () => {
    // Backend emits event:error (no reason — route-catch shape) then closes
    // with no content_block_delta. Exactly one failed card with fallback copy.
    const errorThenStop = [
      'event: error\ndata: {"error":"API key invalid"}\n\n',
      'event: message_stop\ndata: {"full_text":""}\n\n',
    ];
    const fakeFetch = mock(() => Promise.resolve(makeResponse(errorThenStop)));
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "hi";
    await island.send();
    const cards = island.messages.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    // Fixed copy — the server's raw error string is never rendered verbatim.
    expect(cards[0]!.text).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(island.error).toBeNull();
    expect(island.streaming).toBe(false);
  });
});

// ─── classified SSE error events → distinct pet-voice error cards ───────────

describe("SSE error events render reason-mapped error cards", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  async function sendWithEvents(chunks: string[]) {
    const fakeFetch = mock(() => Promise.resolve(makeResponse(chunks)));
    const island = makeChatStreamData(fakeFetch as unknown as typeof fetch);
    island.init();
    island.input = "hi";
    await island.send();
    return island;
  }

  for (const reason of ["timeout", "spawn_failed", "empty_exit"] as const) {
    it(`reason "${reason}" → card with its fixed copy`, async () => {
      const island = await sendWithEvents([
        `event: error\ndata: {"error":"backend detail","reason":"${reason}"}\n\n`,
      ]);
      const cards = island.messages.filter((m) => m.status === "failed");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.text).toBe(CHAT_ERROR_COPY[reason]);
      expect(cards[0]!.error_reason).toBe(reason);
      expect(island.error).toBeNull();
    });
  }

  it("error event after partial deltas → card only, partial buffer dropped", async () => {
    // Mirrors server persistence: a failed turn stores content "" — the
    // partial text the user saw streaming must not become a fake reply.
    const island = await sendWithEvents([
      'event: content_block_delta\ndata: {"text":"half a rep"}\n\n',
      'event: error\ndata: {"error":"x","reason":"timeout"}\n\n',
    ]);
    expect(island.messages.filter((m) => m.role === "assistant" && !m.status)).toHaveLength(0);
    const cards = island.messages.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_COPY.timeout);
  });

  it("malformed error-event JSON → fallback-copy card (no crash, no raw text)", async () => {
    const island = await sendWithEvents(["event: error\ndata: {not json\n\n"]);
    const cards = island.messages.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe(CHAT_ERROR_FALLBACK_COPY);
  });

  it("card copy is never empty — a failed entry can never render blank", async () => {
    const island = await sendWithEvents(['event: error\ndata: {"error":""}\n\n']);
    for (const m of island.messages.filter((x) => x.status === "failed")) {
      expect(m.text.length).toBeGreaterThan(0);
    }
  });
});

// ─── stop() aborts the stream → quiet cancelled marker ──────────────────────

describe("stop() cancels the in-flight turn with a quiet marker", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { addEventListener: () => void; removeEventListener: () => void } }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  it("stop() before any byte → cancelled marker entry, no error copy, composer ready", async () => {
    // fetch stays pending until the send()'s own signal aborts it.
    const fakeFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const island = makeChatStreamData(fakeFetch);
    island.init();
    island.input = "hi";
    const sendP = island.send();
    await new Promise((r) => setTimeout(r, 0));
    expect(island.streaming).toBe(true);

    island.stop();
    await sendP;

    const markers = island.messages.filter((m) => m.status === "cancelled");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toBe(CHAT_STOPPED_MARKER);
    expect(island.error).toBeNull();
    expect(island.messages.filter((m) => m.status === "failed")).toHaveLength(0);
    expect(island.streaming).toBe(false);
    expect(island.buffer).toBe("");
  });

  it("stop() mid-stream → partial buffer dropped, single marker, no error", async () => {
    const enc = new TextEncoder();
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('event: content_block_delta\ndata: {"text":"partial rep"}\n\n'));
          init?.signal?.addEventListener("abort", () =>
            c.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    }) as unknown as typeof fetch;

    const island = makeChatStreamData(fakeFetch);
    island.init();
    island.input = "hi";
    const sendP = island.send();
    // let the partial delta land in the live buffer before stopping
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    island.stop();
    await sendP;

    expect(island.messages.some((m) => m.text.includes("partial rep"))).toBe(false);
    expect(island.messages.filter((m) => m.role === "assistant" && !m.status)).toHaveLength(0);
    expect(island.messages.filter((m) => m.status === "cancelled")).toHaveLength(1);
    expect(island.error).toBeNull();
    expect(island.streaming).toBe(false);
    expect(island.buffer).toBe("");
  });

  it("stop() at idle is a no-op", () => {
    const island = makeChatStreamData(mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch);
    island.init();
    expect(island.abortController).toBeNull();
    expect(() => island.stop()).not.toThrow();
  });
});
