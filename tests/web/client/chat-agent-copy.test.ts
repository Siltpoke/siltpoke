// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [49] step 3, the page half: what the user reads when chat goes to an
// agent other than claude.
//
//   - a failure names the agent it belongs to and points at the Settings page;
//   - with claude (or no agent named — every row stored before [49]) the three
//     original sentences are unchanged;
//   - while an agent that answers in one piece is working, the waiting line
//     says so;
//   - nothing the server sends is rendered unless it is one of five known names.
//
// Both chat surfaces (the floating panel and /chat) are driven through their
// real `send()` against a fake fetch — the sentence on screen is what is
// asserted, not that a helper was called.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeChatStreamData } from "../../../src/web/client/islands/chat-stream";
import { makeFloatingChatData } from "../../../src/web/client/islands/floating-chat";
import {
  CHAT_ERROR_COPY,
  CHAT_ERROR_FALLBACK_COPY,
  chatErrorCopy,
  makeFailedEntry,
  parseErrorEvent,
  wholeReplyNote,
} from "../../../src/web/client/lib/chat-error-copy";

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sseResponse(...chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "X-Siltpoke-Session-Id": "s-deadbeef" },
  });
}

/** A response whose body the test feeds by hand, to look at the island mid-wait. */
function heldResponse(): { res: Response; push: (chunk: string) => void; close: () => void } {
  const enc = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return {
    res: new Response(body, {
      headers: { "content-type": "text/event-stream", "X-Siltpoke-Session-Id": "s-deadbeef" },
    }),
    push: (chunk) => ctl?.enqueue(enc.encode(chunk)),
    close: () => ctl?.close(),
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

describe("chatErrorCopy — the agent is named, and only a known name", () => {
  test("claude, or no agent named: the three original sentences, unchanged", () => {
    for (const reason of ["timeout", "spawn_failed", "empty_exit"] as const) {
      expect(chatErrorCopy(reason)).toBe(CHAT_ERROR_COPY[reason]);
      expect(chatErrorCopy(reason, { provider: "claude" })).toBe(CHAT_ERROR_COPY[reason]);
    }
    expect(CHAT_ERROR_COPY.spawn_failed).toBe(
      "I couldn't reach my brain at all just now. (couldn't start claude — is it installed and logged in?)",
    );
  });

  test("the timeout sentence carries no duration — the limit differs per agent", () => {
    expect(CHAT_ERROR_COPY.timeout).not.toMatch(/minute|second|\d/);
    expect(chatErrorCopy("timeout", { provider: "codex" })).not.toMatch(/minute|second|\d/);
  });

  test("another agent: its name is in the sentence, claude's is not, and Settings is where to go", () => {
    for (const reason of ["timeout", "spawn_failed", "empty_exit", "provider_failed"]) {
      const copy = chatErrorCopy(reason, { provider: "qoder" });
      expect(copy).toContain("qoder");
      expect(copy).not.toContain("claude");
      expect(copy).toContain("Settings page");
    }
  });

  test("no agent found: says so, never 'couldn't start claude'", () => {
    const copy = chatErrorCopy("no_provider");
    expect(copy).toContain("no coding-agent command line was found");
    expect(copy).toContain("Settings page");
    expect(copy).not.toContain("claude");
  });

  test("several found: lists them and asks for a choice on the Settings page", () => {
    const copy = chatErrorCopy("choose_provider", { found: ["codex", "qoder"] });
    expect(copy).toContain("found codex, qoder");
    expect(copy).toContain("choose one for chat on the Settings page");
  });

  // AC13: the cap has a box on the Settings page now, so the sentence sends the
  // user there, to the CHAT cap, and no longer to a key in a file.
  // Spec §12.3: the cap belongs to Chat, whichever agent answers — the
  // sentence must not suggest that another agent has calls left.
  test("daily cap: says the cap is chat's, for every agent, and points to the Settings page", () => {
    const copy = chatErrorCopy("quota_cap", { provider: "codebuddy" });
    expect(copy).toContain("the chat cap on the Settings page");
    expect(copy).toContain("every agent");
    expect(copy).not.toContain("codebuddy reached");
    expect(copy).not.toContain("config.json");
    expect(copy).not.toContain("quota_daily_cap");
  });

  test("the seven sentences are pairwise distinct, and none is the fallback", () => {
    const all = [
      chatErrorCopy("timeout", { provider: "agy" }),
      chatErrorCopy("spawn_failed", { provider: "agy" }),
      chatErrorCopy("empty_exit", { provider: "agy" }),
      chatErrorCopy("provider_failed", { provider: "agy" }),
      chatErrorCopy("no_provider"),
      chatErrorCopy("choose_provider", { found: ["agy", "codex"] }),
      chatErrorCopy("quota_cap", { provider: "agy" }),
    ];
    expect(new Set(all).size).toBe(7);
    expect(all).not.toContain(CHAT_ERROR_FALLBACK_COPY);
  });

  test("a name that is not one of the five never reaches the sentence", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    expect(chatErrorCopy("spawn_failed", { provider: hostile })).toBe(CHAT_ERROR_COPY.spawn_failed);
    expect(chatErrorCopy("provider_failed", { provider: hostile })).not.toContain("<img");
    expect(chatErrorCopy("provider_failed", { provider: 42 })).toContain("the agent");
    const chosen = chatErrorCopy("choose_provider", { found: [hostile, "codex", { a: 1 }, "toString"] });
    expect(chosen).toContain("found codex ");
    expect(chosen).not.toContain("<img");
    expect(chosen).not.toContain("toString");
    expect(chatErrorCopy("choose_provider", { found: "codex" })).toContain("more than one coding agent");
  });
});

describe("parseErrorEvent — carries who, drops what it does not know", () => {
  test("provider and found survive when they are known names", () => {
    expect(parseErrorEvent('{"error":"x","reason":"provider_failed","provider":"codebuddy"}')).toEqual({
      reason: "provider_failed",
      provider: "codebuddy",
    });
    expect(parseErrorEvent('{"error":"x","reason":"choose_provider","found":["codex","nope","agy"]}')).toEqual({
      reason: "choose_provider",
      found: ["codex", "agy"],
    });
  });

  test("an unknown provider is dropped, the reason kept; the raw error string is never extracted", () => {
    const out = parseErrorEvent('{"error":"Please run /login","reason":"provider_failed","provider":"evil"}');
    expect(out).toEqual({ reason: "provider_failed" });
    expect(JSON.stringify(out)).not.toContain("/login");
  });

  test("makeFailedEntry builds the card text from reason + who", () => {
    const who = parseErrorEvent('{"error":"x","reason":"spawn_failed","provider":"codex"}');
    expect(makeFailedEntry(who.reason, who).text).toBe(chatErrorCopy("spawn_failed", { provider: "codex" }));
    expect(makeFailedEntry(who.reason, who).text).toContain("codex");
  });
});

describe("wholeReplyNote — from the server's start event only", () => {
  test("an agent that answers in one piece: a sentence naming it", () => {
    const note = wholeReplyNote('{"message_id":"","model":"","provider":"codebuddy","whole_reply":true}');
    expect(note).toContain("codebuddy");
    expect(note).toContain("in one piece");
  });

  test("claude, a pre-[49] server, and garbage all give nothing", () => {
    expect(wholeReplyNote('{"message_id":"","model":"m","provider":"claude"}')).toBe("");
    expect(wholeReplyNote('{"message_id":"","model":"m"}')).toBe("");
    expect(wholeReplyNote('{"provider":"codex","whole_reply":"true"}')).toBe("");
    expect(wholeReplyNote("not json")).toBe("");
    expect(wholeReplyNote("null")).toBe("");
  });

  test("an unknown name is not echoed", () => {
    const note = wholeReplyNote('{"provider":"<b>x</b>","whole_reply":true}');
    expect(note).not.toContain("<b>");
    expect(note).toContain("this agent");
  });
});

describe("floating chat — live turn", () => {
  function island(fetchFn: typeof fetch) {
    const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
    d.newConversation();
    return d;
  }
  const chatFetch = (res: () => Response): typeof fetch =>
    (async (url: string) => {
      if (String(url).includes("/api/chat/context-preview")) return Response.json({ node: null, page: "/", facts: 0 });
      return res();
    }) as unknown as typeof fetch;

  test("a failure from another agent → the card names that agent", async () => {
    const d = island(
      chatFetch(() =>
        sseResponse(
          frame("message_start", { message_id: "", model: "", provider: "codebuddy", whole_reply: true }),
          frame("error", { error: "codebuddy ran and failed", reason: "provider_failed", provider: "codebuddy" }),
        ),
      ),
    );
    d.draft = "hello";
    await d.send();
    const cards = (d.active()?.messages ?? []).filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toBe(chatErrorCopy("provider_failed", { provider: "codebuddy" }));
    expect(cards[0]?.text).toContain("codebuddy");
  });

  test("choose_provider → the card lists the agents found", async () => {
    const d = island(
      chatFetch(() =>
        sseResponse(
          frame("message_start", { message_id: "", model: "" }),
          frame("error", { error: "x", reason: "choose_provider", found: ["codex", "qoder"] }),
        ),
      ),
    );
    d.draft = "hello";
    await d.send();
    const cards = (d.active()?.messages ?? []).filter((m) => m.status === "failed");
    expect(cards[0]?.text).toContain("found codex, qoder");
  });

  test("while a whole-reply agent works, the waiting line says so; it is gone on the next send", async () => {
    const held = heldResponse();
    let n = 0;
    const d = island(
      chatFetch(() => {
        n += 1;
        return n === 1
          ? held.res
          : sseResponse(
              frame("message_start", { message_id: "", model: "m", provider: "claude" }),
              frame("content_block_delta", { text: "hi" }),
              frame("message_stop", {}),
            );
      }),
    );
    d.draft = "hello";
    const sending = d.send();
    await tick();
    expect(d.waitLabel()).toBe("");
    held.push(frame("message_start", { message_id: "", model: "", provider: "qoder", whole_reply: true }));
    await tick();
    expect(d.waitLabel()).toContain("qoder");
    expect(d.waitLabel()).toContain("in one piece");
    held.push(frame("content_block_delta", { text: "the whole reply" }));
    held.push(frame("message_stop", {}));
    held.close();
    await sending;
    expect((d.active()?.messages ?? []).at(-1)?.text).toBe("the whole reply");

    // A claude turn after it: the note must not carry over.
    d.draft = "again";
    await d.send();
    expect(d.phaseLabel()).toBe("");
  });
});

describe("floating chat — a stored failure reopened later", () => {
  const SESSION = {
    id: "s-hist",
    anchor: null,
    label: "Chat",
    pin: "",
    badge: "",
    title: "q",
    message_count: 2,
    started_at: "2026-10-10T10:00:00.000Z",
  };
  async function loadWithRows(rows: unknown[]) {
    const fetchFn = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/chat/sessions")) return Response.json({ sessions: [SESSION] });
      if (u.includes("/api/chat/sessions/s-hist/messages")) return Response.json({ messages: rows });
      if (u.includes("/api/chat/search")) return Response.json({ matches: [] });
      return Response.json({});
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => false, getViewed: () => null });
    await d.loadSessions();
    return d;
  }

  test("the row's agent is in the sentence, same as when it happened", async () => {
    const d = await loadWithRows([
      { role: "user", text: "q" },
      { role: "assistant", text: "", status: "failed", error_reason: "spawn_failed", error_provider: "agy" },
    ]);
    expect(d.active()?.messages[1]?.text).toBe(chatErrorCopy("spawn_failed", { provider: "agy" }));
  });

  test("choose_provider row → the found agents are listed", async () => {
    const d = await loadWithRows([
      { role: "user", text: "q" },
      { role: "assistant", text: "", status: "failed", error_reason: "choose_provider", error_found: ["agy", "codex"] },
    ]);
    expect(d.active()?.messages[1]?.text).toContain("found agy, codex");
  });

  test("a row stored before [49] (no agent) still reads as it did", async () => {
    const d = await loadWithRows([
      { role: "user", text: "q" },
      { role: "assistant", text: "", status: "failed", error_reason: "spawn_failed" },
    ]);
    expect(d.active()?.messages[1]?.text).toBe(CHAT_ERROR_COPY.spawn_failed);
  });
});

describe("/chat page island", () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
  // Deleted, not set to undefined — see chat-stream.test.ts's afterEach.
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("a failure from another agent → the card names it", async () => {
    const d = makeChatStreamData((async () =>
      sseResponse(
        frame("message_start", { message_id: "", model: "", provider: "codex", whole_reply: true }),
        frame("error", { error: "x", reason: "timeout", provider: "codex" }),
      )) as unknown as typeof fetch);
    d.init();
    d.input = "hi";
    await d.send();
    const cards = d.messages.filter((m) => m.status === "failed");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toBe(chatErrorCopy("timeout", { provider: "codex" }));
  });

  test("the waiting note shows while a whole-reply agent works and is cleared when the turn ends", async () => {
    const held = heldResponse();
    const d = makeChatStreamData((async () => held.res) as unknown as typeof fetch);
    d.init();
    d.input = "hi";
    const sending = d.send();
    await tick();
    expect(d.waitNote).toBe("");
    held.push(frame("message_start", { message_id: "", model: "", provider: "codebuddy", whole_reply: true }));
    await tick();
    expect(d.streaming).toBe(true);
    expect(d.waitNote).toContain("codebuddy");
    held.push(frame("content_block_delta", { text: "done" }));
    held.close();
    await sending;
    expect(d.waitNote).toBe("");
    expect(d.messages.at(-1)?.text).toBe("done");
  });
});
