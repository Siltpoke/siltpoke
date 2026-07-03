import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountHooksRoute } from "../../src/daemon/routes/hooks";

describe("POST /hooks/stop", () => {
  let app: Hono;
  let dir: string;
  let brainCalls: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-"));
    brainCalls = 0;
    app = new Hono();
    mountHooksRoute(app, {
      markerDir: dir,
      secret: "good",
      handleStopHook: async (_e) => {
        brainCalls += 1;
      },
    });
  });

  test("rejects request with no secret header", async () => {
    const res = await app.request("/hooks/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", stop_event_timestamp_ms: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong secret", async () => {
    const res = await app.request("/hooks/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": "bad" },
      body: JSON.stringify({ session_id: "s1", stop_event_timestamp_ms: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("first call returns 202 and invokes handleStopHook", async () => {
    const res = await app.request("/hooks/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": "good" },
      body: JSON.stringify({ session_id: "s1", stop_event_timestamp_ms: 1 }),
    });
    expect(res.status).toBe(202);
    // Detached work — give it time.
    await new Promise((r) => setTimeout(r, 50));
    expect(brainCalls).toBe(1);
  });

  test("duplicate call with same key returns 200 duplicate:true and does NOT re-invoke handleStopHook", async () => {
    const body = JSON.stringify({ session_id: "s1", stop_event_timestamp_ms: 1 });
    const headers = { "Content-Type": "application/json", "X-Siltpoke-Secret": "good" };
    const r1 = await app.request("/hooks/stop", { method: "POST", headers, body });
    expect(r1.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await app.request("/hooks/stop", { method: "POST", headers, body });
    // Dedupe is normal operation, not an error: non-2xx here renders as a red
    // "Stop hook error" in Claude Code even though nothing went wrong.
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, duplicate: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(brainCalls).toBe(1);
  });

  test("different keys both succeed", async () => {
    const headers = { "Content-Type": "application/json", "X-Siltpoke-Secret": "good" };
    const r1 = await app.request("/hooks/stop", {
      method: "POST", headers,
      body: JSON.stringify({ session_id: "s1", stop_event_timestamp_ms: 1 }),
    });
    expect(r1.status).toBe(202);
    const r2 = await app.request("/hooks/stop", {
      method: "POST", headers,
      body: JSON.stringify({ session_id: "s2", stop_event_timestamp_ms: 2 }),
    });
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(brainCalls).toBe(2);
  });
});
