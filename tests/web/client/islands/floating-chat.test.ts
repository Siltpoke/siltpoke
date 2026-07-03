/**
 * floating-chat factory tests.
 *
 * Tests the pure factory `makeFloatingChatData(fetchFn, {getViewed, onGraph})`
 * with injected deps — no Alpine, no real DOM (mirrors chat-stream's testable
 * factory). Covers: canAddContext, pin-to-viewed on new conversation,
 * the anchor riding ONLY the first request, session-id capture, SSE render.
 *
 * Also covers the desync-CTA invariant:
 *  - send-while-desynced intercepts with CTA (does NOT send)
 *  - navigation alone (syncViewed) does NOT trigger CTA
 *  - resolveDesync("reanchor") → PATCHes BE + updates anchorNodeId + proceeds
 *  - resolveDesync("new") → new conv pinned to viewed node + sends there
 *  - in-sync send (viewed == anchor) proceeds unchanged — no CTA
 *  - no anchor conversation → no CTA (general chat proceeds normally)
 *
 * NOTE: the DOM-mount + hx-boost-persist + the repo-graph→global bridge wiring
 * are NOT covered here — those are structurally invisible to factory tests and
 * require guided live smoke. This file proves the conversation/anchor LOGIC,
 * not the rendered behavior.
 */
import { test, expect, describe } from "bun:test";
import { CHAT_ERROR_FALLBACK_COPY } from "../../../../src/web/client/lib/chat-error-copy";
import {
  makeFloatingChatData,
  type ViewedNode,
  type DesyncCta,
} from "../../../../src/web/client/islands/floating-chat";

const VIEWED: ViewedNode = {
  target: { name: "applyDiscount", path: "src/foo.ts", node_type: "function" },
  projHash: "abc123def456",
  label: "applyDiscount",
};

const VIEWED_B: ViewedNode = {
  target: { node_id: "function:src/bar.ts:computeTotal" },
  projHash: "def456abc123",
  label: "computeTotal",
};

function sseBody(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
function delta(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({ text })}\n\n`;
}

/** A fake fetch that records the request body + returns an SSE reply. */
function fakeFetch(record: { bodies: unknown[] }, sessionId = "s-deadbeef"): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    record.bodies.push(JSON.parse(String(init?.body)));
    return new Response(sseBody(delta("it "), delta("multiplies."), `event: message_stop\ndata: {}\n\n`), {
      headers: { "X-Siltpoke-Session-Id": sessionId },
    });
  }) as unknown as typeof fetch;
}

describe("makeFloatingChatData", () => {
  // canAddContext() is ALWAYS true — a chat can be started from ANY page.
  // viewingNode() is the node-vs-page COPY selector (the old gating role
  // moves there).
  test("canAddContext: always true, on-graph or off (un-anchor)", () => {
    const onGraph = { v: true };
    const viewed = { v: VIEWED as ViewedNode | null };
    const d = makeFloatingChatData(fetch, { onGraph: () => onGraph.v, getViewed: () => viewed.v });
    d.syncViewed();
    expect(d.canAddContext()).toBe(true);
    onGraph.v = false;
    expect(d.canAddContext()).toBe(true); // off-graph — still true (was false pre-un-anchor)
    onGraph.v = true;
    viewed.v = null;
    d.syncViewed();
    expect(d.canAddContext()).toBe(true); // no node viewed — still true
  });

  test("viewingNode: on-graph + viewed → true; else false (old gating, moved)", () => {
    const onGraph = { v: true };
    const viewed = { v: VIEWED as ViewedNode | null };
    const d = makeFloatingChatData(fetch, { onGraph: () => onGraph.v, getViewed: () => viewed.v });
    d.syncViewed();
    expect(d.viewingNode()).toBe(true);
    onGraph.v = false;
    expect(d.viewingNode()).toBe(false); // onGraph checked live, no sync needed
    onGraph.v = true;
    viewed.v = null;
    d.syncViewed();
    expect(d.viewingNode()).toBe(false);
  });

  test("syncViewed mirrors the bridge global into reactive state (the stale-UI fix)", () => {
    const viewed = { v: null as ViewedNode | null };
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => viewed.v });
    d.syncViewed();
    expect(d.viewingNode()).toBe(false); // nothing viewed yet
    viewed.v = VIEWED; // user selects a node → bridge global updates
    expect(d.viewingNode()).toBe(false); // STILL false until synced (proves the gap)
    d.syncViewed(); // the bridge event fires syncViewed → reactive mirror updates
    expect(d.viewingNode()).toBe(true);
    expect(d.viewed).toEqual(VIEWED);
  });

  test("newConversation pins to the viewed node + sets active", () => {
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    expect(d.conversations).toHaveLength(1);
    expect(d.activeId).toBe(d.conversations[0].id);
    expect(d.active()?.anchor).toEqual(VIEWED);
    expect(d.active()?.label).toBe("applyDiscount");
    expect(d.active()?.badge).toBe("fn");
  });

  // The old "no-op with nothing to anchor to" behavior is GONE:
  // newConversation() now creates an UN-ANCHORED conversation instead of
  // bailing. Covers both the on-graph-with-no-node-viewed case and the
  // off-graph (any other page) case — both must produce anchor: null.
  test("newConversation creates an UN-ANCHORED conversation when nothing is viewed", () => {
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => null });
    d.newConversation();
    expect(d.conversations).toHaveLength(1); // grows, does NOT stay empty (old behavior)
    expect(d.activeId).toBe(d.conversations[0].id);
    expect(d.active()?.anchor).toBeNull();
    expect(d.active()?.label).toBe("Chat");
    expect(d.active()?.pinSent).toBe(true); // nothing to pin — send() must not try
  });

  test("newConversation creates an UN-ANCHORED conversation on a NON-graph page", () => {
    // onGraph() stubbed false — e.g. /memory. Would fail against
    // the old `if (!this.onGraph() || !viewed) return;` early-return.
    const d = makeFloatingChatData(fetch, { onGraph: () => false, getViewed: () => VIEWED });
    d.newConversation();
    expect(d.conversations).toHaveLength(1);
    expect(d.activeId).toBe(d.conversations[0].id);
    expect(d.active()?.anchor).toBeNull(); // off-graph — never anchors, even if getViewed had a stale node
    expect(d.active()?.label).toBe("Chat");
    expect(d.active()?.pinSent).toBe(true);
  });

  test("first send carries the anchor; reply rendered; session id captured", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    d.draft = "what is this?";
    await d.send();

    // anchor rode the first request (descriptor + proj_hash) — the no-feed point
    // `page` now rides every request too — default pageProvider() reads
    // `location.pathname`, which is undefined in this non-browser test env, so
    // it falls back to "/".
    expect(rec.bodies[0]).toEqual({
      message: "what is this?",
      page: "/",
      anchor: { name: "applyDiscount", path: "src/foo.ts", node_type: "function", proj_hash: "abc123def456" },
    });
    expect(d.active()?.serverSessionId).toBe("s-deadbeef");
    expect(d.active()?.messages.at(-1)).toEqual({ role: "assistant", text: "it multiplies." });
    // first user message becomes the history title locally (no reload needed)
    expect(d.active()?.title).toBe("what is this?");
  });

  test("title is set once — a second send does not overwrite it", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    d.draft = "first question";
    await d.send();
    d.draft = "follow-up";
    await d.send();
    expect(d.active()?.title).toBe("first question");
  });

  test("second send reuses session_id and does NOT re-send the anchor (pin once)", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    d.draft = "first";
    await d.send();
    d.draft = "second";
    await d.send();

    expect(rec.bodies).toHaveLength(2);
    expect((rec.bodies[1] as Record<string, unknown>).session_id).toBe("s-deadbeef");
    expect((rec.bodies[1] as Record<string, unknown>).anchor).toBeUndefined();
  });

  // The un-anchored conv's send/pin path: since anchor is null,
  // `conv.anchor && !conv.pinSent` (the pin-once guard) is false regardless of
  // pinSent, so the request body never carries an `anchor` field and pinSent
  // (already true) is left untouched. Proves the null-anchor path is safe.
  test("send() on an un-anchored conversation never sends an anchor field", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => false, getViewed: () => null });
    d.newConversation();
    expect(d.active()?.anchor).toBeNull();
    d.draft = "hello from any page";
    await d.send();

    expect(rec.bodies).toHaveLength(1);
    expect((rec.bodies[0] as Record<string, unknown>).anchor).toBeUndefined();
    expect(d.active()?.pinSent).toBe(true);
    expect(d.active()?.serverSessionId).toBe("s-deadbeef");
  });

  test("failed first request keeps pinSent false → retry still carries the anchor (HIGH fix)", async () => {
    const rec = { bodies: [] as unknown[] };
    let calls = 0;
    const flaky = (async (_url: string, init?: RequestInit) => {
      rec.bodies.push(JSON.parse(String(init?.body)));
      calls++;
      if (calls === 1) throw new Error("network drop"); // fail before any session id
      return new Response(sseBody(delta("ok")), { headers: { "X-Siltpoke-Session-Id": "s-deadbeef" } });
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(flaky, { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    d.draft = "what is this?";
    await d.send(); // throws internally → caught, error set
    // Transport failures show EXACTLY the fixed fallback copy — never raw
    // internals (mirrors the chat-stream twin's exact assertion).
    expect(d.error).toBe(CHAT_ERROR_FALLBACK_COPY);
    expect(d.active()?.pinSent).toBe(false); // not pinned → retry must re-send anchor
    d.draft = "retry";
    await d.send();
    // the SECOND (successful) request still carries the anchor
    expect((rec.bodies[1] as Record<string, unknown>).anchor).toBeDefined();
    expect(d.active()?.serverSessionId).toBe("s-deadbeef");
  });

  test("send is a no-op with empty draft or no active conversation", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    await d.send(); // no active conversation
    d.newConversation();
    d.draft = "   ";
    await d.send(); // whitespace only
    expect(rec.bodies).toHaveLength(0);
  });

  // ── context-transparency chip bar ────────────────────────────────────────────

  test("send body includes the current page", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const contextPreviewHits: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/chat") {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(sseBody(delta("ok"), `event: message_stop\ndata: {}\n\n`), {
          headers: { "X-Siltpoke-Session-Id": "s-page" },
        });
      }
      if (String(url).startsWith("/api/chat/context-preview")) {
        contextPreviewHits.push(String(url));
        return new Response(JSON.stringify({ page_label: "Memory Book", facts_count: 3 }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, {
      onGraph: () => true,
      getViewed: () => VIEWED,
      pageProvider: () => "/memory",
    });
    d.newConversation();
    d.draft = "hello";
    await d.send();

    // Non-vacuous: the field is present AND carries the injected pathname —
    // dropping `page` from the body (or reading the wrong provider) fails this.
    expect(sent[0].page).toBe("/memory");
    // The context-preview endpoint was hit with the same page (refreshed after send).
    expect(contextPreviewHits[0]).toBe("/api/chat/context-preview?page=%2Fmemory");
  });

  test("transparency bar reflects preview (page + facts) after refreshContextPreview", async () => {
    const fetchFn = (async (url: string) => {
      if (String(url).startsWith("/api/chat/context-preview")) {
        return new Response(JSON.stringify({ page_label: "Memory Book", facts_count: 3 }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { pageProvider: () => "/memory" });
    // No active conversation — the 📍 node chip stays null; page/facts still populate
    // (INTENDED: facts recall is not scoped to an anchored conversation).
    expect(d.contextChips()).toEqual({ node: null, page: "", facts: 0 });

    await d.refreshContextPreview();

    expect(d.contextChips()).toEqual(expect.objectContaining({ page: "Memory Book", facts: 3 }));
    expect(d.contextChips().node).toBeNull();
  });

  test("loadSessions rehydrates conversations newest-first and opens the most recent", async () => {
    const fetchFn = (async (url: string) => {
      if (String(url) === "/api/chat/sessions")
        return new Response(JSON.stringify({ sessions: [
          { id: "s-new", anchor: { node_id: "function:src/eval.ts:runEval" }, label: "runEval", pin: "runEval", badge: "fn", message_count: 2, ended_at: "2026-06-23T11:00:00Z" },
          { id: "s-old", anchor: null, label: "router.ts", pin: "router.ts", badge: "file", message_count: 2, ended_at: "2026-06-23T10:00:00Z" },
        ]}), { status: 200 });
      if (String(url) === "/api/chat/sessions/s-new/messages")
        return new Response(JSON.stringify({ messages: [{ role: "assistant", text: "hello" }] }), { status: 200 });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn);
    await d.loadSessions();
    expect(d.conversations.map((c) => c.id)).toEqual(["s-new", "s-old"]);
    expect(d.activeId).toBe("s-new");
    expect(d.active()?.messages).toEqual([{ role: "assistant", text: "hello" }]);
    // anchorNodeId is set from server anchor
    expect(d.conversations[0].anchorNodeId).toBe("function:src/eval.ts:runEval");
    expect(d.conversations[1].anchorNodeId).toBeNull();
  });

  test("deleteConversation removes it and reselects next", async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn);
    d.conversations = [
      { id: "a", serverSessionId: "a", anchor: null, anchorNodeId: null, label: "a", pin: "a", badge: "fn", pinSent: true, messages: [] },
      { id: "b", serverSessionId: "b", anchor: null, anchorNodeId: null, label: "b", pin: "b", badge: "file", pinSent: true, messages: [] },
    ];
    d.activeId = "a";
    await d.deleteConversation("a");
    expect(d.conversations.map((c) => c.id)).toEqual(["b"]);
    expect(d.activeId).toBe("b");
  });

  test("deleteConversation of the last conversation clears activeId to null", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn);
    d.conversations = [
      { id: "only", serverSessionId: "only", anchor: null, anchorNodeId: null, label: "only", pin: "only", badge: "fn", pinSent: true, messages: [] },
    ];
    d.activeId = "only";
    await d.deleteConversation("only");
    expect(d.conversations).toEqual([]);
    expect(d.activeId).toBeNull();
  });

  test("loadSessions skips the wholesale overwrite when a local unsaved conversation exists (race guard)", async () => {
    let sessionsHit = false;
    const fetchFn = (async (url: string) => {
      if (String(url) === "/api/chat/sessions") {
        sessionsHit = true;
        return new Response(JSON.stringify({ sessions: [
          { id: "s-server", anchor: null, label: "server", pin: "server", badge: "fn", message_count: 3, ended_at: null },
        ]}), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn);
    // a locally-created, not-yet-saved conversation (serverSessionId === null)
    d.conversations = [
      { id: "c1", serverSessionId: null, anchor: null, anchorNodeId: null, label: "local", pin: "local", badge: "fn", pinSent: false, messages: [] },
    ];
    d.activeId = "c1";
    await d.loadSessions();
    // the local conv survives; server sessions were NOT loaded (skip branch fired)
    expect(d.conversations.map((c) => c.id)).toEqual(["c1"]);
    expect(d.activeId).toBe("c1");
    expect(sessionsHit).toBe(true); // we still hit the endpoint, but chose not to overwrite
  });

  test("rehydrated conversation has anchor null → second send carries session_id and NO anchor (locks integration point 5)", async () => {
    const rec = { bodies: [] as unknown[] };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/chat/sessions")
        return new Response(JSON.stringify({ sessions: [
          // the server sends a populated ChatAnchor; loadSessions must NOT map it
          // onto the client conversation (anchor:null), else a re-pin would POST a
          // ChatAnchor with proj_hash:"" → silent wrong-repo.
          { id: "s-1", anchor: { node_id: "function:src/eval.ts:runEval", proj_hash: "realhash", node_name: "runEval", node_type: "function", fingerprint: null, pinned_at: "2026-06-23T11:00:00Z" }, label: "runEval", pin: "src/eval.ts › runEval", badge: "fn", message_count: 2, ended_at: null },
        ]}), { status: 200 });
      if (String(url) === "/api/chat/sessions/s-1/messages")
        return new Response(JSON.stringify({ messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "yo" }] }), { status: 200 });
      if (String(url) === "/api/chat") {
        rec.bodies.push(JSON.parse(String(init?.body)));
        return new Response(sseBody(delta("ok")), { headers: { "X-Siltpoke-Session-Id": "s-1" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    await d.loadSessions();
    // rehydrated conv is structurally un-pinnable
    expect(d.active()?.anchor).toBeNull();
    expect(d.active()?.serverSessionId).toBe("s-1");
    // a follow-up turn on the rehydrated conversation
    d.draft = "follow-up";
    await d.send();
    const body = rec.bodies[0] as Record<string, unknown>;
    expect(body.session_id).toBe("s-1");
    expect("anchor" in body).toBe(false); // NO fabricated anchor leaks to the server
  });

  // ── desync CTA tests ─────────────────────────────────────────────────────────

  test("send-while-desynced intercepts with CTA (does NOT send)", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    // Create a conv pinned to VIEWED's node_id (via descriptor path)
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount", // pinned to VIEWED (A)
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    // Current view is VIEWED_B (node_id: function:src/bar.ts:computeTotal)
    // Anchor is function:src/foo.ts:applyDiscount → DESYNCED
    d.draft = "explain this function";
    await d.send();

    // CTA fires, send does NOT happen
    expect(rec.bodies).toHaveLength(0);
    expect(d.desyncCta).not.toBeNull();
    expect((d.desyncCta as DesyncCta).targetLabel).toBe("computeTotal");
    expect((d.desyncCta as DesyncCta).pendingMessage).toBe("explain this function");
    // Draft is NOT cleared (CTA is showing)
    expect(d.draft).toBe("explain this function");
  });

  test("in-sync send (viewed == anchor) proceeds without CTA", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    // Conv pinned to VIEWED_B's node_id
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-b",
      anchor: null,
      anchorNodeId: "function:src/bar.ts:computeTotal", // matches VIEWED_B
      label: "computeTotal",
      pin: "function:src/bar.ts:computeTotal",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    d.draft = "what does this do?";
    await d.send();

    // No CTA — send proceeded directly
    expect(d.desyncCta).toBeNull();
    expect(rec.bodies).toHaveLength(1);
    expect((rec.bodies[0] as Record<string, unknown>).message).toBe("what does this do?");
  });

  test("no anchor (anchorNodeId null) → no CTA, send proceeds normally", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    // General chat — no anchor
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-general",
      anchor: null,
      anchorNodeId: null, // no anchor
      label: "Chat",
      pin: "",
      badge: "",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    d.draft = "hello";
    await d.send();

    expect(d.desyncCta).toBeNull();
    expect(rec.bodies).toHaveLength(1);
  });

  test("navigation alone (syncViewed) does NOT trigger CTA", async () => {
    const rec = { bodies: [] as unknown[] };
    const viewed = { v: VIEWED_B as ViewedNode | null };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => viewed.v });

    // Conv pinned to VIEWED (A)
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";
    d.syncViewed(); // user navigates to B — this is just a navigation, not a send

    // CTA must NOT appear from navigation alone
    expect(d.desyncCta).toBeNull();
    // No fetch was called
    expect(rec.bodies).toHaveLength(0);
  });

  test("resolveDesync('reanchor') PATCHes server + updates anchorNodeId + sends message", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let patchCallCount = 0;

    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url: String(url), method, body });

      if (method === "PATCH") {
        patchCallCount++;
        return new Response(JSON.stringify({
          ok: true,
          anchor: { node_id: "function:src/bar.ts:computeTotal" },
        }), { status: 200 });
      }
      // POST /api/chat
      return new Response(sseBody(delta("re-anchored reply")), {
        headers: { "X-Siltpoke-Session-Id": "s-a" },
      });
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    // Conv pinned to VIEWED (A), desynced from current view B
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    // First send → intercept CTA
    d.draft = "what does this do?";
    await d.send();
    expect(d.desyncCta).not.toBeNull();

    // User chooses "reanchor"
    await d.resolveDesync("reanchor");

    // PATCH was called
    expect(patchCallCount).toBe(1);
    const patchReq = requests.find((r) => r.method === "PATCH");
    expect(patchReq?.url).toBe("/api/chat/sessions/s-a/anchor");

    // anchorNodeId updated on the conversation
    expect(d.conversations[0].anchorNodeId).toBe("function:src/bar.ts:computeTotal");

    // CTA is cleared
    expect(d.desyncCta).toBeNull();

    // The original message was sent
    const chatReq = requests.find((r) => r.method === "POST" || r.method === undefined);
    expect((chatReq?.body as Record<string, unknown>)?.message).toBe("what does this do?");

    // Reply rendered
    expect(d.active()?.messages.at(-1)?.text).toBe("re-anchored reply");
  });

  test("resolveDesync('reanchor') failure is non-fatal — send still proceeds", async () => {
    const rec = { bodies: [] as unknown[] };

    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        throw new Error("PATCH network error");
      }
      rec.bodies.push(JSON.parse(String(init?.body)));
      return new Response(sseBody(delta("ok")), {
        headers: { "X-Siltpoke-Session-Id": "s-a" },
      });
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    d.draft = "question";
    await d.send();
    expect(d.desyncCta).not.toBeNull();

    // PATCH fails but resolveDesync should not throw and send should still proceed
    await d.resolveDesync("reanchor");

    expect(d.desyncCta).toBeNull();
    expect(rec.bodies).toHaveLength(1); // the POST still went through
    expect((rec.bodies[0] as Record<string, unknown>).message).toBe("question");
  });

  test("resolveDesync('new') creates a new conversation pinned to the viewed node + sends there", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    // Conv pinned to VIEWED (A), desynced. Use a server-style id to avoid collision
    // with the `c${++_seq}` ids generated by resolveDesync("new").
    d.conversations = [{
      id: "s-existing",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "s-existing";

    d.draft = "tell me about this";
    await d.send();
    expect(d.desyncCta).not.toBeNull();

    await d.resolveDesync("new");

    // A new conversation was created
    expect(d.conversations).toHaveLength(2);
    const newConv = d.conversations[1];
    expect(newConv.anchor).toEqual(VIEWED_B); // pinned to B
    expect(d.activeId).toBe(newConv.id);

    // CTA is cleared
    expect(d.desyncCta).toBeNull();

    // The message was sent to the new conversation
    expect(rec.bodies).toHaveLength(1);
    const body = rec.bodies[0] as Record<string, unknown>;
    expect(body.message).toBe("tell me about this");
    // anchor carried on first send (new conv)
    expect((body.anchor as Record<string, unknown>).node_id).toBe("function:src/bar.ts:computeTotal");
  });

  // ── Finding 1: composer bypass guard ─────────────────────────────────────────

  test("Finding 1: send() while CTA pending does NOT dispatch a second request and does NOT clear the CTA", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    d.conversations = [{
      id: "c1",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    // First send → CTA fires
    d.draft = "first message";
    await d.send();
    expect(d.desyncCta).not.toBeNull();

    // Second send while CTA is pending — must be a no-op
    d.draft = "second attempt";
    await d.send();

    // No request dispatched
    expect(rec.bodies).toHaveLength(0);
    // CTA is still set — not cleared by the second send attempt
    expect(d.desyncCta).not.toBeNull();
    // The pending message from the CTA (first message) is still intact
    expect(d.desyncCta?.pendingMessage).toBe("first message");
  });

  // ── Finding 2: resolveDesync("new") pins to captured targetRef, not live viewed ──

  test("Finding 2: resolveDesync('new') pins to CTA's captured targetRef even if viewed changed before click", async () => {
    // VIEWED_C = a third node — the view changes AFTER the CTA fires but BEFORE the click
    const VIEWED_C: ViewedNode = {
      target: { node_id: "function:src/baz.ts:parseArgs" },
      projHash: "baz999",
      label: "parseArgs",
    };

    const rec = { bodies: [] as unknown[] };
    // Start with VIEWED_B as the viewed node when CTA fires
    const viewedRef = { v: VIEWED_B as ViewedNode | null };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => viewedRef.v });
    d.syncViewed();

    d.conversations = [{
      id: "s-existing",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "s-existing";

    // CTA fires with VIEWED_B in view
    d.draft = "tell me about this";
    await d.send();
    expect(d.desyncCta).not.toBeNull();
    // CTA captured VIEWED_B's ref
    expect(d.desyncCta?.targetLabel).toBe("computeTotal");

    // User navigates to VIEWED_C before clicking
    viewedRef.v = VIEWED_C;
    d.syncViewed();

    // User clicks "New chat about <Y>" — should use the CAPTURED ref (VIEWED_B), not the live VIEWED_C
    await d.resolveDesync("new");

    expect(d.conversations).toHaveLength(2);
    const newConv = d.conversations[1];
    // Must be pinned to VIEWED_B (the CTA-captured node), not VIEWED_C
    expect(newConv.anchor?.label).toBe("computeTotal");
    const target = newConv.anchor?.target;
    expect(target && "node_id" in target ? target.node_id : null).toBe("function:src/bar.ts:computeTotal");
    // Message sent with VIEWED_B's anchor, not VIEWED_C's
    const body = rec.bodies[0] as Record<string, unknown>;
    expect((body.anchor as Record<string, unknown>).node_id).toBe("function:src/bar.ts:computeTotal");
  });

  // ── Finding 4: viewedMatchesAnchor descriptor branch coverage ────────────────

  test("Finding 4: viewedMatchesAnchor descriptor form — match and non-match", async () => {
    // Descriptor form: viewed node has name+path (no node_id); anchorNodeId is server-format type:path:name.
    // We test via the send() desync detection path — if descriptor viewed matches the anchorNodeId,
    // no CTA fires; if they differ, CTA fires.

    // CASE A: VIEWED is a descriptor node (name:applyDiscount, path:src/foo.ts)
    // anchorNodeId is "function:src/foo.ts:applyDiscount" — descriptor match → NO CTA.
    const recA = { bodies: [] as unknown[] };
    const dA = makeFloatingChatData(fakeFetch(recA), { onGraph: () => true, getViewed: () => VIEWED });
    dA.syncViewed(); // VIEWED = descriptor {name:applyDiscount, path:src/foo.ts}
    dA.conversations = [{
      id: "c1",
      serverSessionId: "s-a",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount", // matches VIEWED via descriptor
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    dA.activeId = "c1";
    dA.draft = "what does this do?";
    await dA.send();
    // In-sync via descriptor match → no CTA, send proceeded
    expect(dA.desyncCta).toBeNull();
    expect(recA.bodies).toHaveLength(1);

    // CASE B: VIEWED is same path but different name → descriptor non-match → CTA fires.
    const VIEWED_WRONG_NAME: ViewedNode = {
      target: { name: "applyTax", path: "src/foo.ts", node_type: "function" },
      projHash: "abc123def456",
      label: "applyTax",
    };
    const recB = { bodies: [] as unknown[] };
    const dB = makeFloatingChatData(fakeFetch(recB), { onGraph: () => true, getViewed: () => VIEWED_WRONG_NAME });
    dB.syncViewed();
    dB.conversations = [{
      id: "c1",
      serverSessionId: "s-b",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount", // different name → mismatch
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    dB.activeId = "c1";
    dB.draft = "hello";
    await dB.send();
    // Non-match → CTA fires, send does NOT proceed
    expect(dB.desyncCta).not.toBeNull();
    expect(recB.bodies).toHaveLength(0);

    // CASE C: prefix-collision guard — "src/foo.ts" in anchorNodeId "function:src/fooBar.ts:applyDiscount"
    // should NOT match (the `:path:` anchoring prevents false-positive prefix match).
    const VIEWED_PREFIX_COLLISION: ViewedNode = {
      target: { name: "applyDiscount", path: "src/foo.ts", node_type: "function" },
      projHash: "abc123def456",
      label: "applyDiscount",
    };
    const recC = { bodies: [] as unknown[] };
    const dC = makeFloatingChatData(fakeFetch(recC), { onGraph: () => true, getViewed: () => VIEWED_PREFIX_COLLISION });
    dC.syncViewed();
    dC.conversations = [{
      id: "c1",
      serverSessionId: "s-c",
      anchor: null,
      anchorNodeId: "function:src/fooBar.ts:applyDiscount", // different path via prefix collision
      label: "applyDiscount",
      pin: "src/fooBar.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    dC.activeId = "c1";
    dC.draft = "hello";
    await dC.send();
    // Path is "src/fooBar.ts" not "src/foo.ts" → non-match → CTA fires
    expect(dC.desyncCta).not.toBeNull();
    expect(recC.bodies).toHaveLength(0);
  });

  // ── Finding 5: serverSessionId guard before URL interpolation ────────────────

  test("Finding 5: send() skips the PATCH URL if serverSessionId fails SESSION_ID_RE (defense-in-depth)", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "PATCH") {
        return new Response(JSON.stringify({ ok: true, anchor: { node_id: "x" } }), { status: 200 });
      }
      return new Response(sseBody(delta("ok")), { headers: { "X-Siltpoke-Session-Id": "s-clean" } });
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED_B });
    d.syncViewed();

    // Inject a conversation with a malformed serverSessionId
    d.conversations = [{
      id: "c1",
      serverSessionId: "../../evil",    // fails SESSION_ID_RE
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    // Trigger CTA
    d.draft = "hacked";
    await d.send();
    expect(d.desyncCta).not.toBeNull();

    // Resolve reanchor — the PATCH must NOT be dispatched with the malformed id
    await d.resolveDesync("reanchor");

    const patchRequests = requests.filter((r) => r.method === "PATCH");
    expect(patchRequests).toHaveLength(0);
    // The send still proceeds (PATCH skipped, not an error). Filter by the
    // exact chat URL (not just "not PATCH") — a successful send now also
    // triggers a trailing GET to /api/chat/context-preview, which
    // would otherwise be miscounted as a second "post" request here.
    const postRequests = requests.filter((r) => r.url === "/api/chat");
    expect(postRequests).toHaveLength(1);
  });
});

// ── return-to-node reverse bridge ────────────────────────────────────────────

describe("returnToNode", () => {
  /** A fake focus bridge that records the target it was called with. */
  function fakeBridge(record: { calls: Array<ViewedNode["target"]> }, returns = true) {
    const bridge = async (target: ViewedNode["target"]) => {
      record.calls.push(target);
      return returns;
    };
    return bridge;
  }

  test("canReturnToNode: false when no active conversation", () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    expect(d.canReturnToNode()).toBe(false); // no active conversation
  });

  test("canReturnToNode: false when bridge is not mounted (off /repo-graph)", () => {
    const d = makeFloatingChatData(fetch, { onGraph: () => false, getViewed: () => null, getFocusBridge: () => null });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: VIEWED, anchorNodeId: null, label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";
    expect(d.canReturnToNode()).toBe(false);
  });

  test("canReturnToNode: false when active conversation has no anchor", () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: null, label: "Chat", pin: "", badge: "", pinSent: true, messages: [] }];
    d.activeId = "c1";
    expect(d.canReturnToNode()).toBe(false);
  });

  test("canReturnToNode: true when conv has anchor AND bridge is mounted", () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: VIEWED, anchorNodeId: null, label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";
    expect(d.canReturnToNode()).toBe(true);
  });

  test("canReturnToNode: true for rehydrated conv (anchor null, anchorNodeId set) + bridge mounted", () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: "function:src/foo.ts:applyDiscount", label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";
    expect(d.canReturnToNode()).toBe(true);
  });

  test("returnToNode: calls bridge with the anchor target + returns true on success", async () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls, true);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: VIEWED, anchorNodeId: null, label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";

    const result = await d.returnToNode();
    expect(result).toBe(true);
    expect(bridgeCalls.calls).toHaveLength(1);
    expect(bridgeCalls.calls[0]).toEqual(VIEWED.target);
  });

  test("returnToNode: not-mounted → returns false without calling bridge", async () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    // Bridge returns null → not mounted
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => null });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: VIEWED, anchorNodeId: null, label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";

    const result = await d.returnToNode();
    expect(result).toBe(false);
    expect(bridgeCalls.calls).toHaveLength(0);
  });

  test("returnToNode: missing node (bridge returns false) → returns false (forward-compat)", async () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls, false); // bridge reports node not in graph
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: VIEWED, anchorNodeId: null, label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";

    const result = await d.returnToNode();
    expect(result).toBe(false);
    expect(bridgeCalls.calls).toHaveLength(1); // bridge WAS called, but reported not found
  });

  test("returnToNode: rehydrated conv uses anchorNodeId as node_id target when anchor is null", async () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls, true);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    d.conversations = [{ id: "c1", serverSessionId: "s-1", anchor: null, anchorNodeId: "function:src/foo.ts:applyDiscount", label: "applyDiscount", pin: "src/foo.ts › applyDiscount", badge: "fn", pinSent: true, messages: [] }];
    d.activeId = "c1";

    const result = await d.returnToNode();
    expect(result).toBe(true);
    expect(bridgeCalls.calls[0]).toEqual({ node_id: "function:src/foo.ts:applyDiscount" });
  });

  test("returnToNode: no-op when no active conversation (returns false)", async () => {
    const bridgeCalls = { calls: [] as Array<ViewedNode["target"]> };
    const bridge = fakeBridge(bridgeCalls, true);
    const d = makeFloatingChatData(fetch, { onGraph: () => true, getViewed: () => VIEWED, getFocusBridge: () => bridge });
    // No activeId set
    const result = await d.returnToNode();
    expect(result).toBe(false);
    expect(bridgeCalls.calls).toHaveLength(0);
  });
});

// ── FE stale-fingerprint CTA ─────────────────────────────────────────────────

describe("FE stale-fingerprint CTA", () => {
  /** A fake fetch that returns a JSON blocked:stale signal. */
  function staleBlockFetch(sessionId = "s-pinned"): typeof fetch {
    return (async (_url: string) => {
      return new Response(
        JSON.stringify({
          blocked: "stale",
          pinned_fingerprint: "sha-old",
          current_fingerprint: "sha-new",
          pinned_at: "2026-06-22T10:00:00.000Z",
          node_name: "applyDiscount",
          v4_file_level_only: true,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "X-Siltpoke-Session-Id": sessionId,
          },
        },
      );
    }) as unknown as typeof fetch;
  }

  /** A fake fetch that records request bodies + returns an SSE reply. */
  function recordFetch(
    record: { bodies: unknown[] },
    sessionId = "s-pinned",
  ): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      record.bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        sseBody(delta("fresh reply"), `event: message_stop\ndata: {}\n\n`),
        { headers: { "X-Siltpoke-Session-Id": sessionId } },
      );
    }) as unknown as typeof fetch;
  }

  /** Set up a data object with a pre-existing pinned rehydrated conv. */
  function dataWithPinnedConv(fetchFn: typeof fetch): ReturnType<typeof makeFloatingChatData> {
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-pinned",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";
    return d;
  }

  test("send() receiving blocked:stale JSON → staleCta populated + draft restored + no message appended", async () => {
    const d = dataWithPinnedConv(staleBlockFetch());

    d.draft = "what changed?";
    await d.send();

    // staleCta populated
    expect(d.staleCta).not.toBeNull();
    expect(d.staleCta?.nodeName).toBe("applyDiscount");
    expect(d.staleCta?.pinnedAt).toBe("2026-06-22T10:00:00.000Z");
    expect(d.staleCta?.pendingMessage).toBe("what changed?");

    // Draft restored so the user sees what they typed
    expect(d.draft).toBe("what changed?");

    // No optimistic message left in conversation
    expect(d.active()?.messages).toHaveLength(0);

    // Streaming flag was cleaned up
    expect(d.streaming).toBe(false);
  });

  test("send() while staleCta is pending → no-op (composer locked)", async () => {
    const fetchCallCount = { n: 0 };
    const countingFetch = (async (_url: string, init?: RequestInit) => {
      fetchCallCount.n++;
      // First call → stale block; subsequent calls → SSE (would only fire if guard fails)
      if (fetchCallCount.n === 1) {
        return new Response(
          JSON.stringify({ blocked: "stale", pinned_at: "2026-06-22T10:00:00.000Z", node_name: "applyDiscount" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        sseBody(delta("oops"), `event: message_stop\ndata: {}\n\n`),
        { headers: { "X-Siltpoke-Session-Id": "s-pinned" } },
      );
    }) as unknown as typeof fetch;

    const d = dataWithPinnedConv(countingFetch);

    d.draft = "first question";
    await d.send(); // triggers stale CTA
    expect(d.staleCta).not.toBeNull();
    expect(fetchCallCount.n).toBe(1); // only the first stale-block call

    // Second send while CTA is pending — must be a no-op (no new fetch)
    d.draft = "second attempt";
    await d.send();

    // No second request dispatched
    expect(fetchCallCount.n).toBe(1); // still only 1 — guard worked
    // CTA state is still intact from the first send
    expect(d.staleCta?.pendingMessage).toBe("first question");
  });

  test("resolveStale('freeze') → re-sends with anchor_decision:freeze + clears staleCta", async () => {
    const rec = { bodies: [] as unknown[] };
    let callCount = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      rec.bodies.push(body);
      if (callCount === 1) {
        // First call → stale block
        return new Response(
          JSON.stringify({ blocked: "stale", pinned_at: "2026-06-22T10:00:00.000Z", node_name: "applyDiscount" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Second call (with anchor_decision:freeze) → SSE
      return new Response(
        sseBody(delta("frozen reply"), `event: message_stop\ndata: {}\n\n`),
        { headers: { "X-Siltpoke-Session-Id": "s-pinned", "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const d = dataWithPinnedConv(fetchFn);
    d.draft = "keep the old version";
    await d.send();
    expect(d.staleCta).not.toBeNull();

    // User chooses "freeze"
    await d.resolveStale("freeze");

    // staleCta cleared
    expect(d.staleCta).toBeNull();

    // The second request carried anchor_decision: "freeze"
    expect(rec.bodies).toHaveLength(2);
    expect((rec.bodies[1] as Record<string, unknown>).anchor_decision).toBe("freeze");
    expect((rec.bodies[1] as Record<string, unknown>).message).toBe("keep the old version");

    // Reply rendered
    expect(d.active()?.messages.at(-1)?.text).toBe("frozen reply");
  });

  test("resolveStale('continue') → re-sends with anchor_decision:continue + clears staleCta", async () => {
    const rec = { bodies: [] as unknown[] };
    let callCount = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      rec.bodies.push(body);
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ blocked: "stale", pinned_at: "2026-06-22T10:00:00.000Z", node_name: "applyDiscount" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        sseBody(delta("fresh reply"), `event: message_stop\ndata: {}\n\n`),
        { headers: { "X-Siltpoke-Session-Id": "s-pinned", "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const d = dataWithPinnedConv(fetchFn);
    d.draft = "use the new version";
    await d.send();
    expect(d.staleCta).not.toBeNull();

    await d.resolveStale("continue");

    expect(d.staleCta).toBeNull();
    expect((rec.bodies[1] as Record<string, unknown>).anchor_decision).toBe("continue");
    expect(d.active()?.messages.at(-1)?.text).toBe("fresh reply");
  });

  test("non-pinned session or normal SSE response → staleCta stays null", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => true, getViewed: () => VIEWED });
    d.newConversation();
    d.draft = "normal message";
    await d.send();

    // No stale block — staleCta remains null
    expect(d.staleCta).toBeNull();
  });
});

// ── FE dead-anchor terminal state ────────────────────────────────────────────

describe("FE dead-anchor terminal state", () => {
  /** A fake fetch that returns a JSON blocked:node_gone signal. */
  function nodeGoneBlockFetch(sessionId = "s-pinned"): typeof fetch {
    return (async (_url: string) => {
      return new Response(
        JSON.stringify({
          blocked: "node_gone",
          node_name: "applyDiscount",
          pinned_at: "2026-06-22T20:00:00.000Z",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "X-Siltpoke-Session-Id": sessionId,
          },
        },
      );
    }) as unknown as typeof fetch;
  }

  /** Set up a data object with a pre-existing pinned rehydrated conv. */
  function dataWithPinnedConv(fetchFn: typeof fetch): ReturnType<typeof makeFloatingChatData> {
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-pinned",
      anchor: null,
      anchorNodeId: "function:src/foo.ts:applyDiscount",
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";
    return d;
  }

  test("send() receiving blocked:node_gone → terminalCta set + draft cleared + no message appended", async () => {
    const d = dataWithPinnedConv(nodeGoneBlockFetch());

    d.draft = "what changed?";
    await d.send();

    // terminalCta populated
    expect(d.terminalCta).not.toBeNull();
    expect(d.terminalCta?.nodeName).toBe("applyDiscount");

    // Draft is cleared (terminal — no re-send possible)
    expect(d.draft).toBe("");

    // No optimistic message left in conversation
    expect(d.active()?.messages).toHaveLength(0);

    // Streaming flag cleaned up
    expect(d.streaming).toBe(false);
  });

  test("send() while terminalCta is set → no-op (composer permanently locked)", async () => {
    const fetchCallCount = { n: 0 };
    const countingFetch = (async (_url: string) => {
      fetchCallCount.n++;
      return new Response(
        JSON.stringify({ blocked: "node_gone", node_name: "applyDiscount", pinned_at: "2026-06-22T10:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const d = dataWithPinnedConv(countingFetch);

    d.draft = "first question";
    await d.send(); // triggers node_gone → terminalCta
    expect(d.terminalCta).not.toBeNull();
    expect(fetchCallCount.n).toBe(1);

    // Second send while terminal — must be a no-op
    d.draft = "second attempt";
    await d.send();

    // No second request dispatched
    expect(fetchCallCount.n).toBe(1);
    // terminalCta still set
    expect(d.terminalCta).not.toBeNull();
  });

  test("terminalCta is conversation-scoped — switching to a different conv clears nothing global", async () => {
    // After marking c1 terminal, a separate c2 conv can still send
    const rec = { bodies: [] as unknown[] };

    // c1 gets node_gone; c2 gets a normal SSE reply
    let callCount = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // c1 → blocked
        return new Response(
          JSON.stringify({ blocked: "node_gone", node_name: "applyDiscount", pinned_at: "2026-06-22T10:00:00.000Z" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // c2 → normal SSE
      rec.bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        sseBody(delta("reply"), `event: message_stop\ndata: {}\n\n`),
        { headers: { "X-Siltpoke-Session-Id": "s-two" } },
      );
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [
      {
        id: "c1",
        serverSessionId: "s-pinned",
        anchor: null,
        anchorNodeId: "function:src/foo.ts:applyDiscount",
        label: "applyDiscount",
        pin: "src/foo.ts › applyDiscount",
        badge: "fn",
        pinSent: true,
        messages: [],
      },
      {
        id: "c2",
        serverSessionId: "s-two",
        anchor: null,
        anchorNodeId: null,
        label: "Chat",
        pin: "",
        badge: "",
        pinSent: true,
        messages: [],
      },
    ];
    d.activeId = "c1";

    // Mark c1 terminal
    d.draft = "gone?";
    await d.send();
    expect(d.terminalCta).not.toBeNull();

    // Switch to c2 — terminalCta is per-conv (c2 has none)
    d.activeId = "c2";
    d.draft = "normal message";
    await d.send();

    // c2 sent successfully
    expect(rec.bodies).toHaveLength(1);
    expect(d.active()?.messages.at(-1)?.text).toBe("reply");
  });

  test("returnToNode() returning false for a pinned conv → conv marked terminal (return-to-source degrade)", async () => {
    const rec = { bodies: [] as unknown[] };
    const bridge = async (_target: ViewedNode["target"]) => false; // node not in graph
    const d = makeFloatingChatData(fakeFetch(rec), {
      onGraph: () => true,
      getViewed: () => VIEWED,
      getFocusBridge: () => bridge,
    });
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-1",
      anchor: VIEWED, // locally-created pinned conv
      anchorNodeId: null,
      label: "applyDiscount",
      pin: "src/foo.ts › applyDiscount",
      badge: "fn",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    // returnToNode → bridge returns false (node missing)
    const result = await d.returnToNode();
    expect(result).toBe(false);

    // The conv should now be terminal
    const term = d.conversations.find((c) => c.id === "c1")?.terminalCta;
    expect(term).not.toBeUndefined();
    expect(term).not.toBeNull();
  });

  test("returnToNode() returning false for a conv with NO anchor → does NOT mark terminal (general chat)", async () => {
    const rec = { bodies: [] as unknown[] };
    const bridge = async (_target: ViewedNode["target"]) => false;
    const d = makeFloatingChatData(fakeFetch(rec), {
      onGraph: () => true,
      getViewed: () => VIEWED,
      getFocusBridge: () => bridge,
    });
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-1",
      anchor: null,
      anchorNodeId: null, // no anchor at all
      label: "Chat",
      pin: "",
      badge: "",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";

    // returnToNode on no-anchor conv → canReturnToNode returns false → no-op
    const result = await d.returnToNode();
    expect(result).toBe(false);

    // NOT marked terminal (can't return to something that wasn't pinned)
    const term = d.conversations.find((c) => c.id === "c1")?.terminalCta;
    expect(term).toBeUndefined();
  });
});

// ── FE budget + quiet-hours blocked notice ───────────────────────────────────

import { type BlockedCta } from "../../../../src/web/client/islands/floating-chat";

describe("FE budget/quiet-hours blocked notice", () => {
  /** Helper: fake fetch returning a blocked signal. */
  function blockedFetch(signal: { blocked: string; used_pct?: number }): typeof fetch {
    return (async (_url: string) => {
      return new Response(
        JSON.stringify(signal),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
  }

  /** Base data object with one general (non-pinned) conversation. */
  function dataWithConv(fetchFn: typeof fetch): ReturnType<typeof makeFloatingChatData> {
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => VIEWED });
    d.conversations = [{
      id: "c1",
      serverSessionId: "s-1",
      anchor: null,
      anchorNodeId: null,
      label: "Chat",
      pin: "",
      badge: "",
      pinSent: true,
      messages: [],
    }];
    d.activeId = "c1";
    return d;
  }

  test("blocked:budget → blockedCta populated + draft restored + no message appended", async () => {
    const d = dataWithConv(blockedFetch({ blocked: "budget", used_pct: 103.2 }));

    d.draft = "hello budget";
    await d.send();

    // blockedCta populated with budget reason
    expect(d.blockedCta).not.toBeNull();
    expect((d.blockedCta as BlockedCta).reason).toBe("budget");
    expect((d.blockedCta as BlockedCta).message).toContain("Daily budget");

    // Draft restored (user can retry)
    expect(d.draft).toBe("hello budget");

    // No optimistic message left
    expect(d.active()?.messages).toHaveLength(0);

    // Streaming cleaned up
    expect(d.streaming).toBe(false);
  });

  test("blocked:quiet_hours → blockedCta populated + draft restored + message text matches copy", async () => {
    const d = dataWithConv(blockedFetch({ blocked: "quiet_hours" }));

    d.draft = "late night question";
    await d.send();

    expect(d.blockedCta).not.toBeNull();
    expect((d.blockedCta as BlockedCta).reason).toBe("quiet_hours");
    expect((d.blockedCta as BlockedCta).message).toContain("Quiet hours");

    expect(d.draft).toBe("late night question");
    expect(d.active()?.messages).toHaveLength(0);
  });

  test("dismissBlockedCta() → clears blockedCta, composer re-enables", async () => {
    const d = dataWithConv(blockedFetch({ blocked: "quiet_hours" }));
    d.draft = "question";
    await d.send();
    expect(d.blockedCta).not.toBeNull();

    d.dismissBlockedCta();

    expect(d.blockedCta).toBeNull();
    // Draft is still set (restored inside send()), composer would be re-enabled
    expect(d.draft).toBe("question");
  });

  test("send() while blockedCta is pending → no-op (composer locked)", async () => {
    let fetchCalls = 0;
    const countingFetch = (async (_url: string) => {
      fetchCalls++;
      return new Response(
        JSON.stringify({ blocked: "quiet_hours" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const d = dataWithConv(countingFetch);
    d.draft = "first attempt";
    await d.send(); // gets blocked
    expect(d.blockedCta).not.toBeNull();
    expect(fetchCalls).toBe(1);

    // Second send while notice is showing — must be no-op
    d.draft = "second attempt";
    await d.send();
    expect(fetchCalls).toBe(1); // no second request
    expect(d.blockedCta).not.toBeNull(); // still showing
  });

  test("normal SSE response → blockedCta stays null", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = dataWithConv(fakeFetch(rec));
    d.draft = "hello";
    await d.send();

    expect(d.blockedCta).toBeNull();
    expect(rec.bodies).toHaveLength(1);
  });
});
