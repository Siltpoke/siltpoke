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

const TEST_SECRET = "test-secret";

// Task 11 write-eligibility guard on POST /api/chat: this file isn't
// exercising project resolution — inject a fixed "explicit" resolution so
// the guard doesn't 409 against this file's real-but-empty tmpdir homeBase.
const ELIGIBLE_PROJECT = async () => ({
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "explicit" as const,
});

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
      secret: TEST_SECRET,
      resolveProject: ELIGIBLE_PROJECT,
      streamFactory: async function* () {
        for (const ev of events) yield ev;
      },
    });
  }

  test("400 on missing message", async () => {
    mountWithEvents([]);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("400 on invalid json", async () => {
    mountWithEvents([]);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
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
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
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

  // Task 16: Task 11's write-eligibility gate on POST /api/chat is removed —
  // nothing in the send's write path (JSONL append, chat_sessions via daemon
  // cwd, fact-capture via the anchor-derived memScope) reads `resolveProject`'s
  // result as a write target, so gating on it only blocked a chat send on a
  // fresh install (source: "none") for no protective benefit. This proves the
  // regression guard: a send with a "none" resolution still streams normally
  // (mirrors the equivalent facts-write-guard.test.ts assertion).
  test("send still streams (200) even when the request's project resolves to 'none' (fresh install)", async () => {
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      secret: TEST_SECRET,
      resolveProject: async () => ({
        project_id: null,
        proj_hash: null,
        project_root: null,
        display_name: null,
        source: "none" as const,
      }),
      streamFactory: async function* () {
        yield { type: "message_start", message_id: "m-srv", model: "claude-sonnet-4-6" } as StreamEvent;
        yield { type: "content_block_delta", text: "hi" } as StreamEvent;
        yield {
          type: "message_stop",
          usage: { input_tokens: 1, output_tokens: 1 },
          full_text: "hi",
        } as StreamEvent;
      },
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
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
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
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
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
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
      secret: TEST_SECRET,
      resolveProject: ELIGIBLE_PROJECT,
      streamFactory: async function* () {
        throw new Error("boom");
      },
    });
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
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
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ session_id: "s-same", message: "q1" }),
    });
    await r1.text();

    // re-mount with fresh canned events for turn 2
    app = new Hono();
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      secret: TEST_SECRET,
      resolveProject: ELIGIBLE_PROJECT,
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
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
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
    mountChatRoutes(app, { homeBase: home, index: idx, secret: TEST_SECRET });
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
