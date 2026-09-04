import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountHooksRoute } from "../../src/daemon/routes/hooks";

describe("POST /hooks/stop", () => {
  let app: Hono;
  let dir: string;
  let transcriptA: string;
  let transcriptB: string;
  let brainCalls: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-"));
    // The marker key derives from session_id + a hash of the transcript
    // content, so the route needs a real transcript_path to dedupe on.
    transcriptA = join(dir, "a.jsonl");
    transcriptB = join(dir, "b.jsonl");
    writeFileSync(transcriptA, "turn A\n");
    writeFileSync(transcriptB, "turn B\n");
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
      body: JSON.stringify({ session_id: "s1", transcript_path: transcriptA }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong secret", async () => {
    const res = await app.request("/hooks/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": "bad" },
      body: JSON.stringify({ session_id: "s1", transcript_path: transcriptA }),
    });
    expect(res.status).toBe(401);
  });

  test("first call returns 202 and invokes handleStopHook", async () => {
    const res = await app.request("/hooks/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": "good" },
      body: JSON.stringify({ session_id: "s1", transcript_path: transcriptA }),
    });
    expect(res.status).toBe(202);
    // Detached work — give it time.
    await new Promise((r) => setTimeout(r, 50));
    expect(brainCalls).toBe(1);
  });

  test("duplicate call with same key returns 200 duplicate:true and does NOT re-invoke handleStopHook", async () => {
    const body = JSON.stringify({ session_id: "s1", transcript_path: transcriptA });
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
      body: JSON.stringify({ session_id: "s1", transcript_path: transcriptA }),
    });
    expect(r1.status).toBe(202);
    const r2 = await app.request("/hooks/stop", {
      method: "POST", headers,
      body: JSON.stringify({ session_id: "s2", transcript_path: transcriptB }),
    });
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(brainCalls).toBe(2);
  });

  test("missing transcript_path → fail soft: reviews (undeduped) instead of dropping the review", async () => {
    const headers = { "Content-Type": "application/json", "X-Siltpoke-Secret": "good" };
    const res = await app.request("/hooks/stop", {
      method: "POST", headers,
      body: JSON.stringify({ session_id: "s1" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, undeduped: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(brainCalls).toBe(1);
  });
});
