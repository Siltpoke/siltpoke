import { test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { openIndex } from "../../src/chat/fts5-index";
import { appendMessage } from "../../src/chat/jsonl-store";
import { upsertChatSession } from "../../src/chat/sessions";

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "silt-hr-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

function appWith(home: string) {
  const app = new Hono();
  mountChatRoutes(app, { homeBase: home, index: openIndex(home) });
  return app;
}

test("GET /api/chat/sessions lists newest-first", async () => {
  const home = freshHome();
  await upsertChatSession(home, "s-1", new Date("2026-06-23T10:00:00Z"), 2, null);
  const res = await appWith(home).request("/api/chat/sessions");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sessions[0].id).toBe("s-1");
});

test("GET messages returns user/assistant text", async () => {
  const home = freshHome();
  await appendMessage(home, "s-2", { id: "m1", session_id: "s-2", role: "user", content: "hi", ts: "t", model: null, tokens: null, fts_skip: false, claude_session_id: null });
  const res = await appWith(home).request("/api/chat/sessions/s-2/messages");
  expect((await res.json()).messages).toEqual([{ role: "user", text: "hi" }]);
});

test("messages route rejects path-traversal id", async () => {
  const home = freshHome();
  const res = await appWith(home).request("/api/chat/sessions/..%2F..%2Fx/messages");
  expect(res.status).toBe(400);
});

test("DELETE removes metadata + is idempotent", async () => {
  const home = freshHome();
  await upsertChatSession(home, "s-3", new Date(), 2, null);
  const app = appWith(home);
  expect((await app.request("/api/chat/sessions/s-3", { method: "DELETE" })).status).toBe(200);
  expect((await (await app.request("/api/chat/sessions")).json()).sessions).toEqual([]);
  expect((await app.request("/api/chat/sessions/s-3", { method: "DELETE" })).status).toBe(200);
});
