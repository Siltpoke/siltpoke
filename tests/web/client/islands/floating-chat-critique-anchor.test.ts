/**
 * Floating-chat critique-anchor open path (task 5).
 *
 * The Timeline detail pane renders a `[data-siltpoke-critique-chat]` button
 * (data-critique-id + data-proj-hash, computed server-side) — see
 * src/web/screens/timeline/detail-pane.tsx. Clicking it must open the
 * SAME floating-chat island used for graph-node anchoring, but pinned to
 * the critique: send() on a NEW conversation must carry
 * `critique_anchor: { proj_hash, critique_id }` and NOT `anchor`.
 *
 * Also covers the `blocked: "critique_gone"` signal: the backend could not
 * resolve the critique this NEW conversation tried to anchor to. This MUST
 * surface honestly (terminalCta with cause-specific copy) — never a silent
 * no-op, since the whole point of the signal is to avoid answering a
 * question about a review we couldn't actually load.
 *
 * Two layers, mirroring the existing test-suite convention (see
 * floating-chat.test.ts's "FE dead-anchor terminal state" describe block
 * for the node_gone precedent this mirrors):
 *  - factory-level: call openCritiqueChat()/send() directly (no DOM)
 *  - DOM-delegation: happy-dom, click a real button, prove the document-
 *    level listener (added in init()) routes to openCritiqueChat()
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
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
function delta(text: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({ text })}\n\n`;
}

/** A fake fetch that records the request body + returns an SSE reply. */
function fakeFetch(record: { bodies: unknown[] }, sessionId = "s-critique"): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    record.bodies.push(JSON.parse(String(init?.body)));
    return new Response(sseBody(delta("here's "), delta("what I see."), `event: message_stop\ndata: {}\n\n`), {
      headers: { "X-Siltpoke-Session-Id": sessionId, "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

/** A fake fetch that returns a JSON blocked:critique_gone signal. */
function critiqueGoneFetch(): typeof fetch {
  return (async (_url: string) => {
    return new Response(
      JSON.stringify({ blocked: "critique_gone", critique_id: "c-ghost" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("openCritiqueChat() + send() — critique_anchor open path", () => {
  test("first send on a critique-opened conversation carries critique_anchor, not anchor", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => false, getViewed: () => null });

    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });
    expect(d.open).toBe(true);
    expect(d.active()?.critiqueAnchor).toEqual({ proj_hash: "abc123abc123", critique_id: "c-1a2b" });

    d.draft = "what did you flag here?";
    await d.send();

    expect(rec.bodies).toHaveLength(1);
    const body = rec.bodies[0] as Record<string, unknown>;
    expect(body.critique_anchor).toEqual({ proj_hash: "abc123abc123", critique_id: "c-1a2b" });
    expect(body.anchor).toBeUndefined();
    expect(d.active()?.serverSessionId).toBe("s-critique");
    expect(d.active()?.messages.at(-1)).toEqual({ role: "assistant", text: "here's what I see." });
  });

  test("openCritiqueChat() on the SAME critique twice re-focuses the existing conversation instead of duplicating it (Fix 3)", () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => false, getViewed: () => null });

    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });
    const firstId = d.active()?.id;
    expect(d.conversations).toHaveLength(1);

    // Second click on the SAME "chat about this review" button.
    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });

    expect(d.conversations).toHaveLength(1); // no duplicate spawned
    expect(d.active()?.id).toBe(firstId); // re-focused the existing conv
    expect(d.open).toBe(true);
  });

  test("openCritiqueChat() on a critique whose existing conversation is TERMINAL creates a fresh one instead of re-focusing the bricked chat (MINOR 6)", async () => {
    // If the existing conv is terminal (blocked: critique_gone — sending
    // hard-disabled), the naive dedupe match would re-focus a permanently
    // bricked chat, making the Timeline button a silent no-op forever for
    // this critique. It must fall through and create a fresh conversation.
    const d = makeFloatingChatData(critiqueGoneFetch(), { onGraph: () => false, getViewed: () => null });

    d.openCritiqueChat({ critiqueId: "c-ghost", projHash: "abc123abc123" });
    const firstId = d.active()?.id;
    d.draft = "why did you flag this?";
    await d.send(); // send() blocks with critique_gone → sets terminalCta on this conv
    expect(d.active()?.terminalCta?.reason).toBe("critique_gone");
    expect(d.conversations).toHaveLength(1);

    // Second click on the SAME (now terminal) critique.
    d.openCritiqueChat({ critiqueId: "c-ghost", projHash: "abc123abc123" });

    expect(d.conversations).toHaveLength(2); // fresh conv created, not reused
    expect(d.active()?.id).not.toBe(firstId);
    expect(d.active()?.terminalCta).toBeUndefined(); // the new conv is NOT terminal
  });

  test("openCritiqueChat() on a DIFFERENT critique still creates a new conversation", () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => false, getViewed: () => null });

    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });
    d.openCritiqueChat({ critiqueId: "c-different", projHash: "abc123abc123" });

    expect(d.conversations).toHaveLength(2);
    expect(d.active()?.critiqueAnchor).toEqual({
      proj_hash: "abc123abc123",
      critique_id: "c-different",
    });
  });

  test("second send on the same conversation sends neither critique_anchor nor anchor (pin-once)", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), { onGraph: () => false, getViewed: () => null });
    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });

    d.draft = "first";
    await d.send();
    d.draft = "second";
    await d.send();

    expect(rec.bodies).toHaveLength(2);
    const secondBody = rec.bodies[1] as Record<string, unknown>;
    expect(secondBody.critique_anchor).toBeUndefined();
    expect(secondBody.anchor).toBeUndefined();
    expect(secondBody.session_id).toBe("s-critique");
  });

  test("a critique-anchored conversation never desyncs (no graph node to compare against)", async () => {
    // Even with a viewed node present, a critique-anchored conv's
    // anchorNodeId never resolves — desynced requires anchorNodeId !== null,
    // so the CTA can never fire for this conversation kind.
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(fakeFetch(rec), {
      onGraph: () => true,
      getViewed: () => ({
        target: { name: "applyDiscount", path: "src/foo.ts", node_type: "function" },
        projHash: "abc123def456",
        label: "applyDiscount",
      }),
    });
    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });
    d.syncViewed();

    d.draft = "what did you flag here?";
    await d.send();

    expect(d.desyncCta).toBeNull();
    expect(rec.bodies).toHaveLength(1);
  });

  test("canReturnToNode() is false for a critique-anchored conversation (no 'path' misuse)", () => {
    // Regression guard for the known trap: the critique anchor's `path`
    // (the CritiqueContext's cwd, a DIRECTORY) must never be wired into a
    // return-to-source affordance. openCritiqueChat() sets anchor: null +
    // anchorNodeId: null, so canReturnToNode() is structurally false.
    const d = makeFloatingChatData(fakeFetch({ bodies: [] }), {
      onGraph: () => true,
      getFocusBridge: () => async () => true,
    });
    d.openCritiqueChat({ critiqueId: "c-1a2b", projHash: "abc123abc123" });
    expect(d.canReturnToNode()).toBe(false);
  });

  test("canReturnToNode() STAYS false for a critique-anchored conversation rehydrated via loadSessions() (Fix 3)", async () => {
    // The freshly-created path (openCritiqueChat) is a DIFFERENT code path
    // from the rehydrate path (loadSessions() reading the persisted
    // ChatAnchor back after a page reload). The persisted anchor's node_id
    // holds the CRITIQUE id (see ChatAnchor in src/memory/memory.ts) — naively
    // wiring it into anchorNodeId as if it were a graph node id makes
    // canReturnToNode() true and returnToNode() ask the graph bridge for a
    // node that was never a node, which (bridge returns false) permanently
    // bricks the conversation via terminalCta on the very first reload.
    const rehydrateFetch = (async (url: string) => {
      if (String(url).includes("/api/chat/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "s-critique-rehydrated",
                anchor: {
                  node_id: "c-1a2b",
                  node_name: "critique c-1a2b",
                  node_type: "critique",
                  kind: "critique",
                },
                label: "this review",
                pin: "review · c-1a2b",
                badge: "review",
                title: "why did you flag this?",
                message_count: 0,
                started_at: "2026-07-12T00:00:00.000Z",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch in rehydrate test: ${url}`);
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(rehydrateFetch, {
      onGraph: () => true,
      getFocusBridge: () => async () => true,
    });
    await d.loadSessions();

    expect(d.active()?.id).toBe("s-critique-rehydrated");
    // The bug: anchorNodeId would be "c-1a2b" (the critique id, mistaken for
    // a graph node id) → hasFocusTarget true → canReturnToNode() true → the
    // "↩ return to node" button renders for a conversation with no node to
    // return to.
    expect(d.active()?.anchorNodeId).toBeNull();
    expect(d.canReturnToNode()).toBe(false);
  });
});

describe("critique_gone blocked signal — honest surfacing, never a silent no-op", () => {
  test("send() receiving blocked:critique_gone → terminalCta set with critique_gone reason, message not saved", async () => {
    const d = makeFloatingChatData(critiqueGoneFetch(), { onGraph: () => false, getViewed: () => null });
    d.openCritiqueChat({ critiqueId: "c-ghost", projHash: "abc123abc123" });

    d.draft = "what did you flag here?";
    await d.send();

    // Terminal state populated — not a silent no-op.
    expect(d.terminalCta).not.toBeNull();
    expect(d.terminalCta?.reason).toBe("critique_gone");

    // No optimistic user message survives (the turn was never answered,
    // the message was never saved — per the backend contract).
    expect(d.active()?.messages).toHaveLength(0);

    // Draft cleared (terminal — no re-send possible, mirrors node_gone).
    expect(d.draft).toBe("");
    expect(d.streaming).toBe(false);
  });

  test("terminal conversation stays permanently read-only — no-op on further send()", async () => {
    const rec = { bodies: [] as unknown[] };
    const d = makeFloatingChatData(critiqueGoneFetch(), { onGraph: () => false, getViewed: () => null });
    d.openCritiqueChat({ critiqueId: "c-ghost", projHash: "abc123abc123" });
    d.draft = "first try";
    await d.send();

    d.draft = "try again";
    await d.send();

    expect(rec.bodies).toHaveLength(0); // critiqueGoneFetch never records a body
    expect(d.active()?.messages).toHaveLength(0);
  });
});

// ── DOM delegation (needs happy-dom) ────────────────────────────────────────

describe("critique-chat button: click delegation (survives hx-boost cloneNode morph)", () => {
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://127.0.0.1:9876" });
  });

  afterAll(async () => {
    await GlobalRegistrator.unregister();
    globalThis.fetch = realFetch;
  });

  test("clicking [data-siltpoke-critique-chat] opens the panel anchored to that critique", async () => {
    const rec = { bodies: [] as unknown[] };
    // init() calls loadSessions() (GET /api/chat/sessions) — stub it out
    // with an empty list so init() completes without a real conv fetch.
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/chat/sessions")) {
        return new Response(JSON.stringify({ sessions: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).includes("/api/chat/context-preview")) {
        return new Response(JSON.stringify({ page_label: "", facts_count: 0 }), {
          headers: { "content-type": "application/json" },
        });
      }
      return fakeFetch(rec)(url, init);
    }) as unknown as typeof fetch;

    const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
    d.init();

    const btn = document.createElement("button");
    btn.setAttribute("data-siltpoke-critique-chat", "true");
    btn.setAttribute("data-critique-id", "c-delegate-001");
    btn.setAttribute("data-proj-hash", "hash-delegate-001");
    document.body.appendChild(btn);

    // Simulate hx-boost morphing (cloneNode + replaceChild) — the exact
    // repro the recall-chip delegation test guards against — to prove this
    // is a genuine document-level delegated listener, not a per-element one.
    const clone = btn.cloneNode(true) as HTMLElement;
    btn.parentElement!.replaceChild(clone, btn);

    clone.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(d.open).toBe(true);
    expect(d.active()?.critiqueAnchor).toEqual({
      proj_hash: "hash-delegate-001",
      critique_id: "c-delegate-001",
    });

    clone.remove();
  });
});
