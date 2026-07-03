/**
 * Tests for POST /api/critiques/:id/feedback
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountFeedbackRoutes } from "../../src/daemon/routes/feedback";

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-feedback-route-"));
  mkdirSync(tmp, { recursive: true });
  logPath = join(tmp, "preference-log.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountFeedbackRoutes(app, { logPath });
  return app;
}

describe("POST /api/critiques/:id/feedback", () => {
  test("returns 200 and ok:true with valid body", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "good catch on the path traversal" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  test("appends preference-log entry with signal=feedback", async () => {
    const app = buildApp();
    await app.request("/api/critiques/c-log/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "missing null check" }),
    });
    const raw = readFileSync(logPath, "utf8");
    const entry = JSON.parse(raw.trim()) as {
      signal: string;
      critique_id: string;
      reason_text: string;
    };
    expect(entry.signal).toBe("feedback");
    expect(entry.critique_id).toBe("c-log");
    expect(entry.reason_text).toBe("missing null check");
  });

  test("returns 400 when text is missing from body", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-bad/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("text required");
  });

  test("returns 400 when text is empty string", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-empty/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 when body is not valid JSON", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-badjson/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("captures critique_id from route param", async () => {
    const app = buildApp();
    await app.request("/api/critiques/c-param-test/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "feedback text" }),
    });
    const raw = readFileSync(logPath, "utf8");
    const entry = JSON.parse(raw.trim()) as { critique_id: string };
    expect(entry.critique_id).toBe("c-param-test");
  });
});
