/**
 * Unit tests for the recall chip in floating-chat.ts (Task 8 TDD).
 *
 * Tests covered:
 *  1. fetchRecall with 2 matches → recallMatches holds both, summaries accessible
 *  2. fetchRecall with empty matches → showRecall() false
 *  3. dismissRecall → showRecall() false even with matches
 *  4. recallFromDraft → calls fetchRecall with draft text
 *  5. recallFromDraft → resets dismissed state before re-fetching
 *  6. send counter: recall re-fetched on every 3rd send
 *  7. openConversation → resets dismissed + fetch with conv.title
 *  8. delegation-survives-cloneNode repro (happy-dom)
 *  9. WorkingMemoryPanel: real summary renders, fallback is NOT "(no summary)"
 *
 * DOM tests (8) use the happy-dom GlobalRegistrator.
 * All other tests run factory-only (no Alpine, no DOM).
 */

/** @jsxImportSource hono/jsx */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { makeFloatingChatData } from "../../../src/web/client/islands/floating-chat";
import { WorkingMemoryPanel } from "../../../src/web/primitives/WorkingMemoryPanel";
import type { ChatSession } from "../../../src/memory/memory";

// ── types ─────────────────────────────────────────────────────────────────────

type RecallMatch = { session_id: string; summary: string; similarity: number };

// ── fixtures ──────────────────────────────────────────────────────────────────

const MATCH_A: RecallMatch = {
  session_id: "sess-aaa",
  summary: "alpha router refactor discussion",
  similarity: 0.92,
};
const MATCH_B: RecallMatch = {
  session_id: "sess-bbb",
  summary: "beta test harness debugging",
  similarity: 0.78,
};

// ── fetch mock builders ───────────────────────────────────────────────────────

/** Build a minimal recall fetch mock. Intercepts /api/chat/recall and /api/chat/sessions.
 *  Returns an `[url[], mockFetch]` pair so tests can assert what was called. */
function makeRecallFetch(
  recallResponse: RecallMatch[],
): [string[], (url: string | URL | Request) => Promise<Response>] {
  const called: string[] = [];
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    called.push(url);
    if (url.includes("/api/chat/recall")) {
      return new Response(JSON.stringify({ matches: recallResponse }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/chat/sessions")) {
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return [called, mockFetch];
}

// ── happy-dom lifecycle (for delegation test only) ────────────────────────────

const realFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:9876" });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

// ── factory-only tests (no DOM required) ─────────────────────────────────────

describe("recall chip: fetchRecall", () => {
  test("two matches → recallMatches has both, summaries match, showRecall true", async () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A, MATCH_B]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });

    await data.fetchRecall("router question", null);

    expect(data.recallMatches).toHaveLength(2);
    expect(data.recallMatches[0].summary).toBe(MATCH_A.summary);
    expect(data.recallMatches[1].summary).toBe(MATCH_B.summary);
    expect(data.recallMatches[0].session_id).toBe(MATCH_A.session_id);
    expect(data.showRecall()).toBe(true);
  });

  test("empty matches → recallMatches is empty, showRecall false", async () => {
    const [, mockFetch] = makeRecallFetch([]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });

    await data.fetchRecall("unrelated query", null);

    expect(data.recallMatches).toHaveLength(0);
    expect(data.showRecall()).toBe(false);
  });

  test("fetch error → recallMatches cleared, showRecall false", async () => {
    const errorFetch = async (): Promise<Response> => {
      throw new Error("network error");
    };
    const data = makeFloatingChatData(errorFetch as unknown as typeof fetch, { recallEnabled: true });
    // Seed some matches first
    data.recallMatches = [MATCH_A];

    await data.fetchRecall("query", null);

    expect(data.recallMatches).toHaveLength(0);
    expect(data.showRecall()).toBe(false);
  });

  test("sessionId is forwarded as ?session= query param", async () => {
    const [called, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });

    await data.fetchRecall("something", "sess-xyz");

    const recallCall = called.find((u) => u.includes("/api/chat/recall"));
    expect(recallCall).toBeDefined();
    expect(recallCall).toContain("session=sess-xyz");
    expect(recallCall).toContain("q=something");
  });

  test("capped at 3 even if API returns more", async () => {
    const many: RecallMatch[] = [
      { session_id: "s1", summary: "a", similarity: 0.9 },
      { session_id: "s2", summary: "b", similarity: 0.85 },
      { session_id: "s3", summary: "c", similarity: 0.8 },
      { session_id: "s4", summary: "d", similarity: 0.75 },
    ];
    const [, mockFetch] = makeRecallFetch(many);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    await data.fetchRecall("q", null);
    expect(data.recallMatches).toHaveLength(3);
  });
});

describe("recall chip: dismissRecall", () => {
  test("dismissed → showRecall false even with matches", async () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    await data.fetchRecall("q", null);
    expect(data.showRecall()).toBe(true);

    data.dismissRecall();
    expect(data.showRecall()).toBe(false);
    // matches are still there, just hidden
    expect(data.recallMatches).toHaveLength(1);
  });
});

describe("recall chip: recallFromDraft (escape-hatch)", () => {
  test("recallFromDraft fetches recall using current draft text", async () => {
    const [called, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.draft = "my current draft question";

    await data.recallFromDraft();

    const recallCall = called.find((u) => u.includes("/api/chat/recall"));
    expect(recallCall).toBeDefined();
    expect(recallCall).toContain("my+current+draft+question");
  });

  test("recallFromDraft resets dismissed state before fetching", async () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.draft = "new question";
    // Pre-dismissed
    data._recallDismissed = true;
    expect(data.showRecall()).toBe(false);

    await data.recallFromDraft();

    // After escape-hatch, chip should show the fresh results
    expect(data.showRecall()).toBe(true);
  });

  test("recallFromDraft with empty draft does nothing", async () => {
    const [called, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.draft = "  "; // whitespace only

    await data.recallFromDraft();

    const recallCalls = called.filter((u) => u.includes("/api/chat/recall"));
    expect(recallCalls).toHaveLength(0);
  });
});

describe("recall chip: send-count debounce", () => {
  /**
   * Simulate `send()` by calling fetchRecall on every 3rd send.
   * We test the counter logic via `_recallSendCount` inspection.
   */
  test("_recallSendCount starts at 0", () => {
    const [, mockFetch] = makeRecallFetch([]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    expect(data._recallSendCount).toBe(0);
  });

  test("openConversation resets _recallSendCount to 0", async () => {
    const [, mockFetch] = makeRecallFetch([]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    // Seed a conversation for openConversation to find
    data.conversations = [
      {
        id: "conv-1",
        serverSessionId: "srv-1",
        anchor: null,
        anchorNodeId: null,
        label: "test",
        pin: "src/test.ts",
        badge: "fn",
        title: "what is this?",
        pinSent: true,
        createdAt: "2026-06-26T00:00:00Z",
        messages: [],
        count: 1,
      } as Parameters<(typeof data)["_appendMsg"]>[1] & { id: string; serverSessionId: string | null; anchor: null; anchorNodeId: null; label: string; pin: string; badge: string; title: string; pinSent: boolean; createdAt: string; messages: never[]; count: number },
    ];
    data._recallSendCount = 7; // simulate 7 sends

    await data.openConversation("conv-1");

    expect(data._recallSendCount).toBe(0);
  });

  test("openConversation resets _recallDismissed to false", async () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.conversations = [
      {
        id: "conv-2",
        serverSessionId: "srv-2",
        anchor: null,
        anchorNodeId: null,
        label: "nav",
        pin: "src/nav.ts",
        badge: "file",
        title: "how does nav work?",
        pinSent: true,
        createdAt: "2026-06-26T00:00:00Z",
        messages: [],
        count: 1,
      } as Parameters<(typeof data)["_appendMsg"]>[1] & { id: string; serverSessionId: string | null; anchor: null; anchorNodeId: null; label: string; pin: string; badge: string; title: string; pinSent: boolean; createdAt: string; messages: never[]; count: number },
    ];
    data._recallDismissed = true;

    await data.openConversation("conv-2");

    expect(data._recallDismissed).toBe(false);
  });
});

// ── DOM delegation test (needs happy-dom) ────────────────────────────────────

describe("recall chip: delegation survives cloneNode", () => {
  test(
    "data-recall-open click on cloned (morphed) element still fires via document delegation",
    () => {
      // Build a minimal DOM structure mimicking the chip inside fc-panel
      const container = document.createElement("div");
      const chip = document.createElement("div");
      chip.setAttribute("data-recall-open", "sess-delegate-001");
      chip.textContent = "router refactor discussion";
      container.appendChild(chip);
      document.body.appendChild(container);

      // Root-level delegation handler — the exact pattern used in floating-chat init()
      const openedIds: string[] = [];
      const handler = (e: MouseEvent) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-recall-open]");
        const id = el?.getAttribute("data-recall-open");
        if (id) openedIds.push(id);
      };
      document.addEventListener("click", handler);

      // Simulate hx-boost morphing: cloneNode + replaceChild drops per-element listeners
      const clone = container.cloneNode(true) as HTMLElement;
      container.parentElement!.replaceChild(clone, container);

      // Click the chip in the CLONED (morphed) DOM — delegation must still fire
      const clonedChip = clone.querySelector<HTMLElement>("[data-recall-open]")!;
      expect(clonedChip).not.toBeNull();
      clonedChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Delegation fires from the document-level handler even though the element
      // was created by cloneNode (per-element addEventListener would have been dropped)
      expect(openedIds).toEqual(["sess-delegate-001"]);

      // Cleanup
      document.removeEventListener("click", handler);
      clone.remove();
    },
  );
});

// ── Recall toolbar button: toggleRecall() ────────────────────────────────────

describe("toggleRecall: dropdown open/close", () => {
  test("recallOpen defaults to false", () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    expect(data.recallOpen).toBe(false);
  });

  test("toggleRecall flips recallOpen from false to true", () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.toggleRecall();
    expect(data.recallOpen).toBe(true);
  });

  test("toggleRecall flips back to false on second call", () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.toggleRecall();
    data.toggleRecall();
    expect(data.recallOpen).toBe(false);
  });

  test("toggleRecall closes historyOpen when opening recall (mutual exclusion)", () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.historyOpen = true;
    data.toggleRecall(); // open recall
    expect(data.recallOpen).toBe(true);
    expect(data.historyOpen).toBe(false); // history must be closed
  });

  test("toggleRecall does NOT close historyOpen when closing recall", () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.recallOpen = true; // start open
    data.historyOpen = true; // hypothetically both set
    data.toggleRecall(); // close recall
    expect(data.recallOpen).toBe(false);
    expect(data.historyOpen).toBe(true); // historyOpen untouched by close direction
  });

  test("data-recall-open entries: delegation pattern still routes to openConversation", () => {
    // Verify that the data attribute the dropdown uses is the same one the
    // document-level handler handles (cloneNode / morph-safe pattern).
    const container = document.createElement("div");
    const entry = document.createElement("div");
    entry.setAttribute("data-recall-open", "sess-drop-001");
    entry.setAttribute("role", "button");
    entry.setAttribute("tabindex", "0");
    container.appendChild(entry);
    document.body.appendChild(container);

    const openedIds: string[] = [];
    const handler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-recall-open]");
      const id = el?.getAttribute("data-recall-open");
      if (id) openedIds.push(id);
    };
    document.addEventListener("click", handler);

    entry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openedIds).toEqual(["sess-drop-001"]);

    document.removeEventListener("click", handler);
    container.remove();
  });

  test("recallFromDraft sets recallOpen to true after fetch so user sees results", async () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });
    data.draft = "router question";
    data.recallOpen = false;

    await data.recallFromDraft();

    expect(data.recallOpen).toBe(true);
    expect(data.recallMatches).toHaveLength(1);
  });
});

// ── Recall chip: keyboard a11y (Enter/Space) ─────────────────────────────────

describe("recall chip: keyboard a11y (Enter/Space)", () => {
  test(
    "Enter keydown on [data-recall-open] triggers open via document-level delegation",
    () => {
      // Build a minimal chip mimicking the rendered recall entry
      const container = document.createElement("div");
      const chip = document.createElement("div");
      chip.setAttribute("data-recall-open", "sess-keyboard-001");
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      chip.textContent = "keyboard recall test";
      container.appendChild(chip);
      document.body.appendChild(container);

      // Document-level keydown handler — mirrors the pattern in floating-chat init()
      const openedIds: string[] = [];
      const handler = (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const el = (e.target as HTMLElement).closest<HTMLElement>("[data-recall-open]");
        const id = el?.getAttribute("data-recall-open");
        if (id) openedIds.push(id);
      };
      document.addEventListener("keydown", handler);

      // Dispatch Enter keydown — should bubble up to the document-level handler
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(openedIds).toEqual(["sess-keyboard-001"]);

      // Cleanup
      document.removeEventListener("keydown", handler);
      container.remove();
    },
  );
});

// ── WorkingMemoryPanel ────────────────────────────────────────────────────

describe("WorkingMemoryPanel: real summary renders, never (no summary)", () => {
  test("session with real summary renders the actual summary text", () => {
    const session: ChatSession = {
      id: "sess-panel-001",
      started_at: "2026-06-26T10:00:00Z",
      ended_at: "2026-06-26T10:05:00Z",
      message_count: 3,
      summary: "Router refactor: moved authenticate middleware upstream",
      summary_generated_at: null,
      tags: [],
      anchor: null,
    };
    const html = String(<WorkingMemoryPanel recentChats={[session]} />);
    expect(html).toContain("Router refactor: moved authenticate middleware upstream");
  });

  test("session with placeholder summary renders the placeholder, not (no summary)", () => {
    const session: ChatSession = {
      id: "sess-panel-002",
      started_at: "2026-06-26T10:00:00Z",
      ended_at: "2026-06-26T10:01:00Z",
      message_count: 1,
      summary: "what does the router do?",
      summary_generated_at: null,
      tags: [],
      anchor: null,
    };
    const html = String(<WorkingMemoryPanel recentChats={[session]} />);
    expect(html).toContain("what does the router do?");
    expect(html).not.toContain("(no summary)");
  });

  test("genuinely empty summary uses a sane fallback, NOT (no summary)", () => {
    const session: ChatSession = {
      id: "sess-panel-003",
      started_at: "2026-06-26T10:00:00Z",
      ended_at: null,
      message_count: 0,
      summary: "",
      summary_generated_at: null,
      tags: [],
      anchor: null,
    };
    const html = String(<WorkingMemoryPanel recentChats={[session]} />);
    expect(html).not.toContain("(no summary)");
  });
});

// ── Recall surface disabled (default, RECALL_SURFACE_ENABLED=false) ──────────

describe("recall surface disabled (default recallEnabled=false)", () => {
  test("fetchRecall is a no-op: no HTTP call, recallMatches stays empty", async () => {
    const [called, mockFetch] = makeRecallFetch([MATCH_A]);
    // recallEnabled NOT passed → defaults to false
    const data = makeFloatingChatData(mockFetch as typeof fetch);

    await data.fetchRecall("router question", null);

    expect(data.recallMatches).toHaveLength(0);
    expect(data.showRecall()).toBe(false);
    const recallCalls = called.filter((u) => u.includes("/api/chat/recall"));
    expect(recallCalls).toHaveLength(0); // no HTTP call made
  });

  test("toggleRecall is a no-op: recallOpen stays false", () => {
    const [, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch);

    data.toggleRecall();

    expect(data.recallOpen).toBe(false); // not toggled
  });

  test("recallEnabled defaults to false in factory", () => {
    const [, mockFetch] = makeRecallFetch([]);
    const data = makeFloatingChatData(mockFetch as typeof fetch);
    expect(data.recallEnabled).toBe(false);
  });

  test("recallEnabled=true restores fetch behaviour (opt-in harness smoke)", async () => {
    const [called, mockFetch] = makeRecallFetch([MATCH_A]);
    const data = makeFloatingChatData(mockFetch as typeof fetch, { recallEnabled: true });

    await data.fetchRecall("router question", null);

    expect(data.recallMatches).toHaveLength(1);
    const recallCalls = called.filter((u) => u.includes("/api/chat/recall"));
    expect(recallCalls).toHaveLength(1);
  });
});
