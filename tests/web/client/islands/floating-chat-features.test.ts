/**
 * New-feature tests: renderMarkdown (Feature 1) + maximize toggle (Feature 2).
 *
 * renderMarkdown tests:
 *  - Markdown subset renders correctly (bold, italic, code, fence, headings, lists, links)
 *  - XSS safety: <script>, <img onerror>, javascript: links all neutralized
 *  - HTML-escape-first guarantees: raw HTML tags in input appear as visible text
 *
 * maximize toggle tests:
 *  - Default false; toggleMaximize() → true → false (round-trip)
 *  - Escape key handler restores panel (via init() keydown listener)
 *  - Launcher state is unaffected by maximized
 */
import { test, expect, describe } from "bun:test";
import {
  renderMarkdown,
  makeFloatingChatData,
  STARTER_PROMPTS,
  type ViewedNode,
} from "../../../../src/web/client/islands/floating-chat";

const VIEWED: ViewedNode = {
  target: { name: "applyDiscount", path: "src/foo.ts", node_type: "function" },
  projHash: "abc123def456",
  label: "applyDiscount",
};

// ── Feature 1: renderMarkdown ─────────────────────────────────────────────────

describe("renderMarkdown — Markdown subset rendering", () => {
  test("plain text passthrough — no markdown → text appears as-is in a <p>", () => {
    const out = renderMarkdown("Hello world");
    expect(out).toContain("Hello world");
    // Wrapped in a paragraph
    expect(out).toContain("<p");
  });

  test("bold: **text** → <strong>", () => {
    const out = renderMarkdown("This is **bold** text.");
    expect(out).toContain("<strong>bold</strong>");
  });

  test("italic: *text* → <em>", () => {
    const out = renderMarkdown("This is *italic* text.");
    expect(out).toContain("<em>italic</em>");
  });

  test("italic: _text_ → <em>", () => {
    const out = renderMarkdown("This is _italic_ text.");
    expect(out).toContain("<em>italic</em>");
  });

  test("inline code: `code` → <code>", () => {
    const out = renderMarkdown("Use `myFunc()` here.");
    expect(out).toContain('<code class="fc-md-ic">myFunc()</code>');
  });

  test("fenced code block → <pre><code>", () => {
    const src = "```ts\nconst x = 1;\n```";
    const out = renderMarkdown(src);
    expect(out).toContain('<pre class="fc-md-pre">');
    expect(out).toContain('<code class="fc-md-code">');
    expect(out).toContain("const x = 1;");
  });

  test("heading # → <h2 class=\"fc-md-h\">", () => {
    const out = renderMarkdown("# My Heading");
    expect(out).toContain('<h2 class="fc-md-h">My Heading</h2>');
  });

  test("heading ## → <h3>", () => {
    const out = renderMarkdown("## Sub-heading");
    expect(out).toContain('<h3 class="fc-md-h">Sub-heading</h3>');
  });

  test("heading ### → <h4>", () => {
    const out = renderMarkdown("### Small heading");
    expect(out).toContain('<h4 class="fc-md-h">Small heading</h4>');
  });

  test("unordered list (- item) → <ul><li>", () => {
    const out = renderMarkdown("- alpha\n- beta\n- gamma");
    expect(out).toContain('<ul class="fc-md-ul">');
    expect(out).toContain("<li>alpha</li>");
    expect(out).toContain("<li>beta</li>");
    expect(out).toContain("<li>gamma</li>");
    expect(out).toContain("</ul>");
  });

  test("unordered list (* item) → <ul><li>", () => {
    const out = renderMarkdown("* one\n* two");
    expect(out).toContain('<ul class="fc-md-ul">');
    expect(out).toContain("<li>one</li>");
  });

  test("ordered list (1. item) → <ol><li>", () => {
    const out = renderMarkdown("1. first\n2. second");
    expect(out).toContain('<ol class="fc-md-ol">');
    expect(out).toContain("<li>first</li>");
    expect(out).toContain("<li>second</li>");
    expect(out).toContain("</ol>");
  });

  test("link [text](url) → <a href=...> for https", () => {
    const out = renderMarkdown("See [example](https://example.com) for more.");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("example");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  test("link [text](url) → <a href=...> for http", () => {
    const out = renderMarkdown("Visit [site](http://site.org).");
    expect(out).toContain('href="http://site.org"');
  });

  test("paragraphs separated by blank line → separate <p> blocks", () => {
    const out = renderMarkdown("First paragraph.\n\nSecond paragraph.");
    // Both paragraphs should appear
    expect(out).toContain("First paragraph.");
    expect(out).toContain("Second paragraph.");
    // Two separate paragraph elements
    const pCount = (out.match(/<p /g) ?? []).length;
    expect(pCount).toBeGreaterThanOrEqual(2);
  });
});

// ── Feature 1: XSS safety ─────────────────────────────────────────────────────

describe("renderMarkdown — XSS safety (escape-first guarantee)", () => {
  test("XSS: <script>alert(1)</script> in model text → appears as visible escaped text, NOT executed", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    // The output must NOT contain a live <script> tag
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    // The escaped form must appear
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;/script&gt;");
  });

  test("XSS: <img src=x onerror=alert(1)> → inert escaped text", () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    // No live <img> tag
    expect(out).not.toMatch(/<img\s/i);
    // Escaped form present
    expect(out).toContain("&lt;img");
  });

  test("XSS: javascript: scheme in link → no live href created, rendered as inert text", () => {
    const out = renderMarkdown("[click me](javascript:alert(1))");
    // No href attribute — the link is NOT an active <a> element
    expect(out).not.toContain("href=");
    // The visible text content is present (inert form, not executed)
    expect(out).toContain("click me");
    // The scheme may appear as visible text, but there is no anchor wrapping it
    expect(out).not.toContain("<a ");
  });

  test("XSS: data: URL in link → dropped, rendered as inert text", () => {
    const out = renderMarkdown("[img](data:text/html,<script>alert(1)</script>)");
    expect(out).not.toContain('href="data:');
    expect(out).toContain("img");
  });

  test("XSS: raw & in model text → &amp; (not a double-encoded entity)", () => {
    const out = renderMarkdown("a & b");
    expect(out).toContain("&amp;");
    // Double-encoding is not present
    expect(out).not.toContain("&amp;amp;");
  });

  test("XSS: raw < and > outside of markdown syntax → escaped", () => {
    const out = renderMarkdown("x < y > z");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    // No literal unescaped < or > in output (outside of our own generated tags)
    // Check the raw text portion — we expect the escaped form
    expect(out).toContain("x &lt; y &gt; z");
  });

  test("XSS: inline code containing <script> → script tag is escaped, not executed", () => {
    const out = renderMarkdown("Run `<script>evil()</script>` now.");
    // Inside the <code> tag, the content must be escaped
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("XSS: fenced code block containing HTML attack → escaped inside <pre><code>", () => {
    const src = "```\n<script>alert('xss')</script>\n```";
    const out = renderMarkdown(src);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("XSS: attribute injection attempt in bold text → escaped", () => {
    const out = renderMarkdown('**"><img src=x onerror=alert(1)>**');
    // The injected HTML inside bold must not be a live tag
    expect(out).not.toMatch(/<img\s/i);
    expect(out).toContain("&lt;img");
  });
});

// ── Feature 2: maximize toggle ────────────────────────────────────────────────

describe("maximized toggle on FloatingChatData", () => {
  test("default false", () => {
    const d = makeFloatingChatData(fetch);
    expect(d.maximized).toBe(false);
  });

  test("toggleMaximize() → true", () => {
    const d = makeFloatingChatData(fetch);
    d.toggleMaximize();
    expect(d.maximized).toBe(true);
  });

  test("toggleMaximize() called twice → back to false (round-trip)", () => {
    const d = makeFloatingChatData(fetch);
    d.toggleMaximize();
    d.toggleMaximize();
    expect(d.maximized).toBe(false);
  });

  test("maximized state is independent per factory instance", () => {
    const d1 = makeFloatingChatData(fetch);
    const d2 = makeFloatingChatData(fetch);
    d1.toggleMaximize();
    expect(d1.maximized).toBe(true);
    // d2 is unaffected
    expect(d2.maximized).toBe(false);
  });

  test("_collapsePanel tidies open/history/maximized away (nav collapse)", () => {
    const d = makeFloatingChatData(fetch);
    d.open = true;
    d.historyOpen = true;
    d.toggleMaximize();
    expect(d.maximized).toBe(true);
    d._collapsePanel();
    expect(d.open).toBe(false);
    expect(d.historyOpen).toBe(false);
    expect(d.maximized).toBe(false);
  });

  test("closing the panel resets maximized → reopening lands in corner mode", () => {
    const d = makeFloatingChatData(fetch);
    d.open = true;
    d.toggleMaximize();
    expect(d.maximized).toBe(true);
    // user clicks × to close while maximized
    d.toggle();
    expect(d.open).toBe(false);
    expect(d.maximized).toBe(false);
    // re-open via launcher → corner mode, not the dismissed modal
    d.toggle();
    expect(d.open).toBe(true);
    expect(d.maximized).toBe(false);
  });

  test("renderMd delegates to renderMarkdown — bold renders", () => {
    const d = makeFloatingChatData(fetch);
    const out = d.renderMd("This is **bold**.");
    expect(out).toContain("<strong>bold</strong>");
  });

  test("renderMd: XSS in model text is neutralized via the delegate path", () => {
    const d = makeFloatingChatData(fetch);
    const out = d.renderMd("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

// ── Auto-scroll feature ───────────────────────────────────────────────────────

/** Minimal $refs shape for tests. */
type RefsCarrier = { $refs?: { scrollBody?: { scrollTop: number; scrollHeight: number } } };
type TickCarrier = { $nextTick?: (cb: () => void) => void };

describe("auto-scroll message body", () => {
  test("scrollToBottom() is a safe no-op when $refs is absent (no DOM in tests)", () => {
    const d = makeFloatingChatData(fetch);
    // No $refs injected — must not throw
    expect(() => d.scrollToBottom()).not.toThrow();
  });

  test("scrollToBottom() sets scrollTop = scrollHeight on the scrollBody ref", () => {
    const d = makeFloatingChatData(fetch);
    const fakeEl = { scrollTop: 0, scrollHeight: 1234 };
    (d as RefsCarrier).$refs = { scrollBody: fakeEl };
    d.scrollToBottom();
    expect(fakeEl.scrollTop).toBe(1234);
  });

  test("scrollToBottom() no-ops when $refs is present but scrollBody is missing", () => {
    const d = makeFloatingChatData(fetch);
    (d as RefsCarrier).$refs = {};
    expect(() => d.scrollToBottom()).not.toThrow();
  });

  test("_deferScroll() no-ops when $nextTick is absent (factory tests)", () => {
    const d = makeFloatingChatData(fetch);
    expect(() => d._deferScroll()).not.toThrow();
  });

  test("_deferScroll() schedules scrollToBottom via $nextTick when present", () => {
    const d = makeFloatingChatData(fetch);
    const fakeEl = { scrollTop: 0, scrollHeight: 500 };
    (d as RefsCarrier).$refs = { scrollBody: fakeEl };
    let ticked = false;
    (d as TickCarrier).$nextTick = (cb: () => void) => {
      ticked = true;
      cb();
    };
    d._deferScroll();
    expect(ticked).toBe(true);
    expect(fakeEl.scrollTop).toBe(500);
  });

  test("send() triggers a deferred scroll after appending user message + assistant reply", async () => {
    const enc = new TextEncoder();
    const fetchFn = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ text: "hi" })}\n\n`));
          c.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
          c.close();
        },
      });
      return new Response(body, { headers: { "X-Siltpoke-Session-Id": "s-1" } });
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    const fakeEl = { scrollTop: 0, scrollHeight: 900 };
    (d as RefsCarrier).$refs = { scrollBody: fakeEl };
    let tickCount = 0;
    (d as TickCarrier).$nextTick = (cb: () => void) => {
      tickCount++;
      cb();
    };

    d.newConversation();
    d.draft = "hello";
    await d.send();

    // $nextTick fires for the user-message append AND the assistant-reply append.
    expect(tickCount).toBeGreaterThanOrEqual(2);
    expect(fakeEl.scrollTop).toBe(900);
  });

  test("openConversation() triggers a deferred scroll (land at latest)", async () => {
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith("/messages")) {
        return new Response(JSON.stringify({ messages: [{ role: "assistant", text: "old" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn);
    const fakeEl = { scrollTop: 0, scrollHeight: 640 };
    (d as RefsCarrier).$refs = { scrollBody: fakeEl };
    let ticked = false;
    (d as TickCarrier).$nextTick = (cb: () => void) => {
      ticked = true;
      cb();
    };
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [], count: 1 },
    ];
    await d.openConversation("c1");

    expect(ticked).toBe(true);
    expect(fakeEl.scrollTop).toBe(640);
  });
});

// ── Starter-prompt chips ──────────────────────────────────────────────────────

/** SSE-replying fake fetch that records request bodies. */
function recordingFetch(record: { bodies: unknown[] }, sessionId = "s-1"): typeof fetch {
  const enc = new TextEncoder();
  return (async (_url: string, init?: RequestInit) => {
    record.bodies.push(JSON.parse(String(init?.body)));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ text: "ok" })}\n\n`));
        c.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
        c.close();
      },
    });
    return new Response(body, { headers: { "X-Siltpoke-Session-Id": sessionId } });
  }) as unknown as typeof fetch;
}

describe("starter-prompt chips", () => {
  test("STARTER_PROMPTS is exactly the 4 approved prompts (no caller-impact prompt)", () => {
    expect(STARTER_PROMPTS).toEqual([
      "What does this do?",
      "Explain it like I'm new to this codebase",
      "Walk me through it step by step",
      "What are the key functions and how do they connect?",
    ]);
    // The deferred caller-impact prompt must NOT be present.
    expect(STARTER_PROMPTS.some((p) => /breaks|change this|caller/i.test(p))).toBe(false);
  });

  test("starterPrompts is exposed on the data object and mirrors STARTER_PROMPTS", () => {
    const d = makeFloatingChatData(fetch);
    expect(d.starterPrompts).toEqual(STARTER_PROMPTS);
  });

  test("showStarters: false when there is no active conversation", () => {
    const d = makeFloatingChatData(fetch);
    expect(d.showStarters()).toBe(false);
  });

  test("showStarters: true for a fresh conversation (zero messages, no CTA)", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "c1";
    expect(d.showStarters()).toBe(true);
  });

  test("showStarters: false once the conversation has any message", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [{ role: "user", text: "hi" }] },
    ];
    d.activeId = "c1";
    expect(d.showStarters()).toBe(false);
  });

  test("showStarters: false when a desync CTA is pending (even on a fresh conv)", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "c1";
    d.desyncCta = { targetLabel: "X", targetRef: { node_id: "n", proj_hash: "h" }, pendingMessage: "m" };
    expect(d.showStarters()).toBe(false);
  });

  test("showStarters: false when a stale CTA is pending", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "c1";
    d.staleCta = { pinnedAt: "2026-06-22T10:00:00Z", nodeName: "X", pendingMessage: "m" };
    expect(d.showStarters()).toBe(false);
  });

  test("showStarters: false when a blocked CTA is pending", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "c1";
    d.blockedCta = { reason: "budget", message: "paused" };
    expect(d.showStarters()).toBe(false);
  });

  test("showStarters: false when the active conversation is terminal", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [], terminalCta: { nodeName: "X" } },
    ];
    d.activeId = "c1";
    expect(d.showStarters()).toBe(false);
  });

  test("sendStarter sets the draft to the prompt and dispatches a request with that exact text", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(recordingFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();

    await d.sendStarter("Walk me through it step by step");

    // Exactly one request, carrying the chip's exact text.
    expect(rec.bodies).toHaveLength(1);
    expect((rec.bodies[0] as Record<string, unknown>).message).toBe("Walk me through it step by step");
    // The user message was appended (conv is no longer fresh).
    expect(d.active()?.messages[0]).toEqual({ role: "user", text: "Walk me through it step by step" });
  });

  test("sendStarter goes through the send() path → chips hide afterward (conv now has a message)", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(recordingFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    expect(d.showStarters()).toBe(true);

    await d.sendStarter("What does this do?");

    // After sending, the conversation has messages → chips no longer show.
    expect(d.showStarters()).toBe(false);
  });

  test("sendStarter respects the pre-flight gates — no dispatch when a blocked CTA is pending", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(recordingFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [
      { id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "c1", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "c1";
    d.blockedCta = { reason: "budget", message: "paused" };

    await d.sendStarter("What does this do?");

    // send() short-circuits on blockedCta → no request dispatched.
    expect(rec.bodies).toHaveLength(0);
  });
});

// ── Streaming-scope fix (per-conversation streaming) ──────────────────────────

/**
 * A controllable streaming fetch — the returned Response's body stays OPEN until
 * `release()` is called, so a test can switch conversations WHILE the stream is
 * in flight, then release to deliver the reply. Mirrors the SSE stub shape.
 */
function controllableStreamFetch(sessionId = "s-A") {
  let releaseFn: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const enc = new TextEncoder();
  const fetchFn = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        // Wait until the test releases, THEN emit the reply + close.
        await released;
        c.enqueue(enc.encode(`event: content_block_delta\ndata: ${JSON.stringify({ text: "A-reply" })}\n\n`));
        c.enqueue(enc.encode("event: message_stop\ndata: {}\n\n"));
        c.close();
      },
    });
    return new Response(body, { headers: { "X-Siltpoke-Session-Id": sessionId } });
  }) as unknown as typeof fetch;
  return { fetchFn, release: () => releaseFn() };
}

describe("streaming-scope: per-conversation streaming", () => {
  test("reply streamed AFTER switching conversations lands in the ORIGINATING conv, not the newly-active one", async () => {
    const { fetchFn, release } = controllableStreamFetch("s-A");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });

    // Conversation A — fresh.
    d.conversations = [
      { id: "A", serverSessionId: "s-A", anchor: null, anchorNodeId: null, label: "A", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "A";

    // Start the send on A (do NOT await — the stream is paused).
    d.draft = "ask A";
    const sending = d.send();

    // While A is streaming, the user creates/switches to conversation B.
    d.conversations = [
      ...d.conversations,
      { id: "B", serverSessionId: "s-B", anchor: null, anchorNodeId: null, label: "B", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "B";

    // Now release A's stream and let send() finish.
    release();
    await sending;

    const convA = d.conversations.find((c) => c.id === "A");
    const convB = d.conversations.find((c) => c.id === "B");
    // The assistant reply landed in A (the originating conv)...
    expect(convA?.messages.at(-1)).toEqual({ role: "assistant", text: "A-reply" });
    // ...and B is untouched (no misrouted reply).
    expect(convB?.messages).toHaveLength(0);
  });

  test("isActiveStreaming() is false on a different conv while another streams", async () => {
    const { fetchFn, release } = controllableStreamFetch("s-A");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [
      { id: "A", serverSessionId: "s-A", anchor: null, anchorNodeId: null, label: "A", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "A";

    d.draft = "ask A";
    const sending = d.send();

    // While A streams and A is active → the dots gate is true.
    expect(d.streaming).toBe(true);
    expect(d.streamingConvId).toBe("A");
    expect(d.isActiveStreaming()).toBe(true);

    // Switch to a fresh conv B — the dots gate must go false (B is not streaming).
    d.conversations = [
      ...d.conversations,
      { id: "B", serverSessionId: "s-B", anchor: null, anchorNodeId: null, label: "B", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "B";
    expect(d.isActiveStreaming()).toBe(false);

    release();
    await sending;

    // After completion the gate is false everywhere.
    expect(d.streaming).toBe(false);
    expect(d.streamingConvId).toBeNull();
    expect(d.isActiveStreaming()).toBe(false);
  });

  test("fresh conv B shows starters and NOT dots while A streams; A shows neither", async () => {
    const { fetchFn, release } = controllableStreamFetch("s-A");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [
      { id: "A", serverSessionId: "s-A", anchor: null, anchorNodeId: null, label: "A", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "A";

    d.draft = "ask A";
    const sending = d.send();

    // On A (active, streaming): the user message is appended → starters hidden,
    // and isActiveStreaming() is true → dots show. Never both.
    expect(d.showStarters()).toBe(false);
    expect(d.isActiveStreaming()).toBe(true);

    // Switch to fresh conv B.
    d.conversations = [
      ...d.conversations,
      { id: "B", serverSessionId: "s-B", anchor: null, anchorNodeId: null, label: "B", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "B";

    // On B (active, fresh, NOT streaming): starters show, dots do NOT.
    expect(d.showStarters()).toBe(true);
    expect(d.isActiveStreaming()).toBe(false);
    // Never co-render on the same conv: showStarters() && isActiveStreaming() is false.
    expect(d.showStarters() && d.isActiveStreaming()).toBe(false);

    release();
    await sending;
  });

  test("starters + dots never co-render on the same (streaming) conv", async () => {
    const { fetchFn, release } = controllableStreamFetch("s-A");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [
      { id: "A", serverSessionId: "s-A", anchor: null, anchorNodeId: null, label: "A", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "A";

    d.draft = "q";
    const sending = d.send();

    // On the streaming conv: dots gate true, starters false → never both.
    expect(d.isActiveStreaming()).toBe(true);
    expect(d.showStarters()).toBe(false);
    expect(d.showStarters() && d.isActiveStreaming()).toBe(false);

    release();
    await sending;
  });

  test("auto-scroll does NOT fire for the originating conv when the user switched away", async () => {
    const { fetchFn, release } = controllableStreamFetch("s-A");
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    const fakeEl = { scrollTop: 0, scrollHeight: 700 };
    (d as { $refs?: { scrollBody?: { scrollTop: number; scrollHeight: number } } }).$refs = { scrollBody: fakeEl };
    let scrolls = 0;
    (d as { $nextTick?: (cb: () => void) => void }).$nextTick = (cb: () => void) => {
      scrolls++;
      cb();
    };
    d.conversations = [
      { id: "A", serverSessionId: "s-A", anchor: null, anchorNodeId: null, label: "A", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "A";

    d.draft = "ask A";
    const sending = d.send();
    // The user-message append scrolled once (A was active at send-start).
    const scrollsAfterUserMsg = scrolls;

    // Switch to B before the reply arrives.
    d.conversations = [
      ...d.conversations,
      { id: "B", serverSessionId: "s-B", anchor: null, anchorNodeId: null, label: "B", pin: "", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "B";

    release();
    await sending;

    // The assistant-append scroll must NOT have fired (A is no longer active).
    expect(scrolls).toBe(scrollsAfterUserMsg);
  });
});

// ── History list: newest-created-first sort + per-row created label ───────────

describe("history list — newest-first sort + created timestamp", () => {
  const conv = (id: string, createdAt?: string) => ({
    id,
    serverSessionId: `s-${id}`,
    anchor: null,
    anchorNodeId: null,
    label: id,
    pin: "",
    badge: "fn" as const,
    pinSent: true,
    messages: [],
    ...(createdAt !== undefined ? { createdAt } : {}),
  });

  test("sortedConversations orders newest-created first; a locally-appended newer conv jumps to the top", () => {
    const d = makeFloatingChatData(fetch);
    // Simulates the bug: older convs first, a freshly-created one appended LAST.
    d.conversations = [
      conv("old", "2026-06-23T10:00:00.000Z"),
      conv("mid", "2026-06-23T15:00:00.000Z"),
      conv("new", "2026-06-23T20:00:00.000Z"),
    ];
    expect(d.sortedConversations().map((c) => c.id)).toEqual(["new", "mid", "old"]);
  });

  test("conversations without createdAt sort last (stable)", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [conv("none1"), conv("dated", "2026-06-23T12:00:00.000Z"), conv("none2")];
    const ids = d.sortedConversations().map((c) => c.id);
    expect(ids[0]).toBe("dated");
    expect(ids.slice(1).sort()).toEqual(["none1", "none2"]);
  });

  test("sortedConversations is non-mutating — the tab-strip array order is untouched", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [conv("a", "2026-06-23T10:00:00.000Z"), conv("b", "2026-06-23T20:00:00.000Z")];
    d.sortedConversations();
    expect(d.conversations.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("newConversation stamps createdAt so a fresh chat is the newest", () => {
    const d = makeFloatingChatData(fetch);
    d.conversations = [conv("old", "2026-06-23T10:00:00.000Z")];
    // Force the on-graph + viewed preconditions newConversation() needs.
    (d as unknown as { onGraph(): boolean }).onGraph = () => true;
    (d as unknown as { syncViewed(): void }).syncViewed = () => {};
    (d as unknown as { viewed: unknown }).viewed = { label: "fresh", target: { node_id: "n", proj_hash: "h" } };
    d.newConversation();
    const fresh = d.conversations.find((c) => c.id !== "old");
    if (!fresh) throw new Error("newConversation did not append a conversation");
    expect(fresh.createdAt).toBeTruthy();
    expect(d.sortedConversations()[0]?.id).toBe(fresh.id);
  });

  test("fmtCreated: ISO → 'date · time'; null / invalid → ''", () => {
    const d = makeFloatingChatData(fetch);
    expect(d.fmtCreated(null)).toBe("");
    expect(d.fmtCreated("not-a-date")).toBe("");
    const s = d.fmtCreated("2026-06-23T20:38:00.000Z");
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain("·");
  });
});
