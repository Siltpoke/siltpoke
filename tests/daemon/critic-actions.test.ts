/**
 * Tests for POST /api/critic/action — dismiss/ack a brain-call entry.
 *
 * The handler appends to ~/.siltpoke/critic-actions.jsonl. criticTelemetry
 * reads that file to attach `user_action` to matching entries.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, readFile, writeFile, } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import { mountCriticRoutes } from "../../src/web/routes/critic";

let homeBase: string;

beforeEach(async () => {
  homeBase = join(tmpdir(), `critic-actions-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountCriticRoutes(app, { homeBase });
  return app;
}

describe("POST /api/critic/action", () => {
  test("appends dismiss entry to critic-actions.jsonl", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s1",
        timestamp: "2026-05-19T14:00:00Z",
        action: "dismiss",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const path = join(homeBase, "critic-actions.jsonl");
    expect(existsSync(path)).toBe(true);
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.session_id).toBe("s1");
    expect(entry.timestamp).toBe("2026-05-19T14:00:00Z");
    expect(entry.action).toBe("dismiss");
    expect(typeof entry.at).toBe("string");
  });

  test("appends ack entry", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s2",
        timestamp: "2026-05-19T14:05:00Z",
        action: "ack",
      }),
    });
    expect(res.status).toBe(200);
    const raw = await readFile(join(homeBase, "critic-actions.jsonl"), "utf8");
    const entry = JSON.parse(raw.split("\n").filter(Boolean)[0]!) as Record<string, unknown>;
    expect(entry.action).toBe("ack");
  });

  test("accepts clear action", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", timestamp: "t1", action: "clear" }),
    });
    expect(res.status).toBe(200);
    const raw = await readFile(join(homeBase, "critic-actions.jsonl"), "utf8");
    const entry = JSON.parse(raw.split("\n").filter(Boolean)[0]!) as Record<string, unknown>;
    expect(entry.action).toBe("clear");
  });

  test("rejects invalid action", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", timestamp: "t", action: "explode" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing session_id", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timestamp: "t", action: "dismiss" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("budget POST patches config.json", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dailyTokenLimit: 1_000_000,
        softWarnAtPercent: 70,
        hardStopAtPercent: 95,
      }),
    });
    expect(res.status).toBe(200);
    const cfg = JSON.parse(await readFile(join(homeBase, "config.json"), "utf8")) as Record<string, unknown>;
    const budget = cfg.budget as Record<string, number>;
    expect(budget.dailyTokenLimit).toBe(1_000_000);
    expect(budget.softWarnAtPercent).toBe(70);
    expect(budget.hardStopAtPercent).toBe(95);
  });

  test("budget POST rejects out-of-range", async () => {
    const app = buildApp();
    const res = await app.request("/api/critic/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softWarnAtPercent: 999 }),
    });
    expect(res.status).toBe(400);
  });

  test("budget POST preserves unrelated config fields", async () => {
    await writeFile(join(homeBase, "config.json"), JSON.stringify({ name: "siltpoke", budget: { dailyTokenLimit: 500_000 } }), "utf8");
    const app = buildApp();
    const res = await app.request("/api/critic/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softWarnAtPercent: 60 }),
    });
    expect(res.status).toBe(200);
    const cfg = JSON.parse(await readFile(join(homeBase, "config.json"), "utf8")) as Record<string, unknown>;
    expect(cfg.name).toBe("siltpoke");
    expect((cfg.budget as Record<string, number>).dailyTokenLimit).toBe(500_000);
    expect((cfg.budget as Record<string, number>).softWarnAtPercent).toBe(60);
  });

  test("multiple actions append in order", async () => {
    const app = buildApp();
    await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", timestamp: "t1", action: "dismiss" }),
    });
    await app.request("/api/critic/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s1", timestamp: "t1", action: "ack" }),
    });
    const raw = await readFile(join(homeBase, "critic-actions.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).action).toBe("dismiss");
    expect(JSON.parse(lines[1]!).action).toBe("ack");
  });
});
