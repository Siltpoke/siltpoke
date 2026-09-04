/**
 * floating-chat Stop wiring (client leg) — factory tests + SSR markup, no
 * Alpine/DOM runtime.
 *
 * While a turn is streaming, the composer's round send button becomes a
 * stop affordance (still enabled) wired to stopStreaming(), which aborts
 * the in-flight fetch. A stop renders the quiet cancelled marker (no
 * apology copy, no error styling), drops any partial buffer, and returns
 * the composer to ready (streaming=false) immediately — the abort is
 * never an error.
 */
import { describe, expect, test } from "bun:test";
import { makeFloatingChatData } from "../../../../src/web/client/islands/floating-chat";
import { CHAT_STOPPED_MARKER } from "../../../../src/web/client/lib/chat-error-copy";
import { FloatingChat } from "../../../../src/web/_shared/FloatingChat";

function delta(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({ text })}\n\n`;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "X-Siltpoke-Session-Id": "s-stop",
};

/** fetch fake whose /api/chat call NEVER settles until the signal aborts —
 * mirrors a hung stream the user stops before any byte arrives. */
function pendingUntilAbortFetch(): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    if (String(url).includes("/api/chat/context-preview")) {
      return Promise.resolve(Response.json({ node: null, page: "/", facts: 0 }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    });
  }) as unknown as typeof fetch;
}

/** fetch fake that streams one partial delta then holds the body open; an
 * abort errors the body with AbortError — mirrors real fetch mid-stream. */
function midStreamAbortFetch(): typeof fetch {
  const enc = new TextEncoder();
  return ((url: string, init?: RequestInit) => {
    if (String(url).includes("/api/chat/context-preview")) {
      return Promise.resolve(Response.json({ node: null, page: "/", facts: 0 }));
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(delta("half a partial ")));
        init?.signal?.addEventListener("abort", () =>
          c.error(new DOMException("The operation was aborted.", "AbortError")),
        );
      },
    });
    return Promise.resolve(new Response(body, { headers: SSE_HEADERS }));
  }) as unknown as typeof fetch;
}

function makeIsland(fetchFn: typeof fetch) {
  const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
  d.newConversation();
  return d;
}

async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("stopStreaming() aborts the in-flight send", () => {
  test("stop before any byte: quiet cancelled marker, no error copy, composer ready", async () => {
    const d = makeIsland(pendingUntilAbortFetch());
    d.draft = "hello";
    const sendP = d.send();
    await tick();
    expect(d.streaming).toBe(true);
    expect(d.abortController).not.toBeNull();

    d.stopStreaming();
    await sendP;

    const msgs = d.active()?.messages ?? [];
    const markers = msgs.filter((m) => m.status === "cancelled");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toBe(CHAT_STOPPED_MARKER);
    // never an error state: no error line, no failed card
    expect(d.error).toBeNull();
    expect(msgs.filter((m) => m.status === "failed")).toHaveLength(0);
    // composer ready immediately
    expect(d.streaming).toBe(false);
    expect(d.streamingConvId).toBeNull();
    expect(d.abortController).toBeNull();
  });

  test("stop mid-stream: partial buffer dropped, single quiet marker", async () => {
    const d = makeIsland(midStreamAbortFetch());
    d.draft = "hello";
    const sendP = d.send();
    await tick(5); // let the partial delta land in the local buffer

    d.stopStreaming();
    await sendP;

    const msgs = d.active()?.messages ?? [];
    // partial text never renders as an assistant bubble
    expect(msgs.some((m) => m.text.includes("half a partial"))).toBe(false);
    expect(msgs.filter((m) => m.role === "assistant" && !m.status)).toHaveLength(0);
    expect(msgs.filter((m) => m.status === "cancelled")).toHaveLength(1);
    expect(d.error).toBeNull();
    expect(d.streaming).toBe(false);
  });

  test("marker lands in the ORIGINATING conversation after a mid-stream switch", async () => {
    const d = makeIsland(pendingUntilAbortFetch());
    const originId = d.activeId;
    d.draft = "hello";
    const sendP = d.send();
    await tick();

    d.newConversation(); // switch away mid-stream
    const newId = d.activeId;
    expect(newId).not.toBe(originId);

    d.stopStreaming();
    await sendP;

    const origin = d.conversations.find((c) => c.id === originId);
    const fresh = d.conversations.find((c) => c.id === newId);
    expect((origin?.messages ?? []).filter((m) => m.status === "cancelled")).toHaveLength(1);
    expect((fresh?.messages ?? []).filter((m) => m.status === "cancelled")).toHaveLength(0);
  });

  test("stopStreaming() at idle is a no-op", () => {
    const d = makeIsland(pendingUntilAbortFetch());
    expect(d.abortController).toBeNull();
    expect(() => d.stopStreaming()).not.toThrow();
    expect(d.streaming).toBe(false);
  });
});

describe("SSR markup: composer send button swaps to a stop affordance", () => {
  const html = String(FloatingChat());

  test("submit button is wired to stopStreaming() while streaming", () => {
    expect(html).toContain("stopStreaming()");
  });

  test("button type swaps to plain button while streaming (stop click must not re-submit)", () => {
    expect(html).toContain("streaming ? &#39;button&#39; : &#39;submit&#39;");
  });

  test("stop glyph swap is bound (■ while streaming, ↑ otherwise)", () => {
    expect(html).toContain("■");
    expect(html).toContain("↑");
  });

  test("button stays ENABLED while streaming (stop must be clickable)", () => {
    // The old behavior hard-disabled the button on `streaming` — the swap
    // keeps it enabled as the stop control.
    expect(html).toContain("streaming ? false");
  });

  test("accessible name swaps between Send and Stop", () => {
    expect(html).toContain("&#39;Stop&#39;");
    expect(html).toContain("&#39;Send&#39;");
  });

  test("input stays disabled while streaming (one question at a time — unchanged)", () => {
    expect(html).toMatch(/:disabled="streaming \|\| desyncCta/);
  });
});

describe("SSR markup: critique_gone terminal CTA has its own copy (MINOR 7 / prior wave's FIX 4)", () => {
  const html = String(FloatingChat());

  test("renders the critique-specific headline, gated by its OWN x-show (split from the node_gone headline)", () => {
    expect(html).toContain("I can&#39;t load that review any more");
    expect(html).toContain(`x-show="terminalCta?.reason === &#39;critique_gone&#39;"`);
  });

  test("the node_gone headline is gated by the COMPLEMENTARY x-show (never shown together)", () => {
    expect(html).toContain(`x-show="terminalCta?.reason !== &#39;critique_gone&#39;"`);
    expect(html).toContain("was renamed or removed");
  });

  test("critique_gone gets its own follow-up line, distinct from the node-anchor 'current version of this code' copy", () => {
    expect(html).toContain("Start a new chat if you&#39;d like to ask about something else.");
    expect(html).toContain("Start a new chat to continue exploring the current version of this code.");
  });
});
