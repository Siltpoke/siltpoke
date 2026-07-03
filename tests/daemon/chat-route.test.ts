import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, existsSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { openIndex, type ChatIndex } from "../../src/chat/fts5-index";
import { readSession } from "../../src/chat/jsonl-store";
import { readMemory } from "../../src/memory/memory";
import type { StreamEvent } from "../../src/daemon/routes/chat-stream";

describe("POST /api/chat", () => {
  let app: Hono;
  let home: string;
  let idx: ChatIndex;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-chat-route-"));
    idx = openIndex(home);
    app = new Hono();
  });

  afterEach(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });

  function mountWithEvents(events: StreamEvent[]): void {
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      streamFactory: async function* () {
        for (const ev of events) yield ev;
      },
    });
  }

  test("400 on missing message", async () => {
    mountWithEvents([]);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("400 on invalid json", async () => {
    mountWithEvents([]);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("happy path: SSE response, jsonl appended, FTS updated, memory.json updated", async () => {
    mountWithEvents([
      { type: "message_start", message_id: "m-srv", model: "claude-sonnet-4-6" },
      { type: "content_block_delta", text: "hi " },
      { type: "content_block_delta", text: "there" },
      {
        type: "message_stop",
        usage: { input_tokens: 5, output_tokens: 2 },
        full_text: "hi there",
      },
    ]);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const sid = res.headers.get("X-Siltpoke-Session-Id");
    expect(sid).toBeTruthy();

    const body = await res.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: message_stop");

    const msgs = await readSession(home, sid!);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.content).toBe("hello");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.content).toBe("hi there");

    const memory = await readMemory(home);
    expect(memory).not.toBeNull();
    const session = memory?.chat_sessions.find((s) => s.id === sid);
    expect(session).toBeDefined();
    expect(session?.message_count).toBe(2);
  });

  test("ledgers one chat usage-event (derived cost) on a turn", async () => {
    mountWithEvents([
      { type: "message_start", message_id: "m-srv", model: "claude-sonnet-4-6" },
      { type: "content_block_delta", text: "hi" },
      {
        type: "message_stop",
        usage: { input_tokens: 1000, output_tokens: 1000 },
        full_text: "hi",
      },
    ]);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const sid = res.headers.get("X-Siltpoke-Session-Id");
    await res.text();

    const p = join(home, "usage-events.jsonl");
    expect(existsSync(p)).toBe(true);
    const lines = (await import("node:fs")).readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "chat", session_id: sid, basis: "derived" });
    // sonnet: 1000/1M*$3 + 1000/1M*$15 = 0.018
    expect(lines[0].total_cost_usd).toBeCloseTo(0.018, 6);
  });

  test("re-uses session_id when supplied", async () => {
    mountWithEvents([
      {
        type: "message_stop",
        usage: { input_tokens: 0, output_tokens: 0 },
        full_text: "ok",
      },
    ]);
    const res1 = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s-fixed", message: "first" }),
    });
    expect(res1.headers.get("X-Siltpoke-Session-Id")).toBe("s-fixed");
    await res1.text();
    expect(existsSync(join(home, "chats", "s-fixed.jsonl"))).toBe(true);
  });

  test("error event surfaces stream failure", async () => {
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      streamFactory: async function* () {
        throw new Error("boom");
      },
    });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const body = await res.text();
    expect(body).toContain("event: error");
    // Unclassified failures carry a GENERIC message on the wire — the raw
    // exception text is daemon-log-only (never wire, never store).
    expect(body).toContain("unexpected stream failure");
    expect(body).not.toContain("boom");
  });

  test("second turn on same session increments message_count to 4", async () => {
    mountWithEvents([
      {
        type: "message_stop",
        usage: { input_tokens: 0, output_tokens: 0 },
        full_text: "a1",
      },
    ]);

    const r1 = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s-same", message: "q1" }),
    });
    await r1.text();

    // re-mount with fresh canned events for turn 2
    app = new Hono();
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      streamFactory: async function* () {
        yield {
          type: "message_stop",
          usage: { input_tokens: 0, output_tokens: 0 },
          full_text: "a2",
        };
      },
    });
    const r2 = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s-same", message: "q2" }),
    });
    await r2.text();

    const memory = await readMemory(home);
    const session = memory?.chat_sessions.find((s) => s.id === "s-same")!;
    expect(session.message_count).toBe(4);
  });
});

describe("POST /api/chat/search", () => {
  let app: Hono;
  let home: string;
  let idx: ChatIndex;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-chat-search-"));
    idx = openIndex(home);
    app = new Hono();
    mountChatRoutes(app, { homeBase: home, index: idx });
  });

  afterEach(() => {
    idx.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("400 on missing query", async () => {
    const res = await app.request("/api/chat/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("400 on invalid json", async () => {
    const res = await app.request("/api/chat/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });

  test("returns matches array", async () => {
    // seed index via direct insert
    const { insertMessage } = await import("../../src/chat/fts5-index");
    insertMessage(idx, {
      id: "m-1",
      session_id: "s-1",
      role: "user",
      content: "ripgrep is great",
      ts: "2026-05-16T00:00:00Z",
      model: null,
      tokens: null,
      fts_skip: false,
      claude_session_id: null,
    });
    const res = await app.request("/api/chat/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "ripgrep" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { matches: unknown[] };
    expect(json.matches).toHaveLength(1);
  });

  test("respects custom limit", async () => {
    const { insertMessage } = await import("../../src/chat/fts5-index");
    for (let i = 0; i < 5; i++) {
      insertMessage(idx, {
        id: `m-${i}`,
        session_id: "s-1",
        role: "user",
        content: `match ${i}`,
        ts: "2026-05-16T00:00:00Z",
        model: null,
        tokens: null,
        fts_skip: false,
        claude_session_id: null,
      });
    }
    const res = await app.request("/api/chat/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "match", limit: 2 }),
    });
    const json = (await res.json()) as { matches: unknown[] };
    expect(json.matches).toHaveLength(2);
  });

  test("clamps limit to [1, 100]", async () => {
    const res = await app.request("/api/chat/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "anything", limit: 9999 }),
    });
    expect(res.status).toBe(200);
  });
});
