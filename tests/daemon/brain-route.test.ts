// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tests for the brain-select route (Slice C / Task 8).
 *
 *   GET  /api/brain                 -> resolved brain view (read-only)
 *   POST /api/brain/roles/:role     -> set brain.roles[role] (secret-gated)
 *
 * The POST reuses the SAME `runBrainSet` the `/siltpoke-brain` command calls,
 * so the dashboard and the command are one source of truth by construction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountBrainRoutes } from "../../src/daemon/routes/brain";

let home: string;
const TEST_SECRET = "test-secret";
const SAVED_HOST = process.env.SILTPOKE_HOST;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-brain-route-"));
  delete process.env.SILTPOKE_HOST;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (SAVED_HOST === undefined) delete process.env.SILTPOKE_HOST;
  else process.env.SILTPOKE_HOST = SAVED_HOST;
});

function buildApp(): Hono {
  const app = new Hono();
  mountBrainRoutes(app, { homeBase: home, secret: TEST_SECRET });
  return app;
}

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET };
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

describe("GET /api/brain", () => {
  test("returns the resolved brain view", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      authorFamily: string;
      roles: { role: string; family: string; source: string }[];
      families: string[];
    };
    expect(json.roles.some((r) => r.role === "review")).toBe(true);
    expect(json.families).toContain("qoder");
  });
});

describe("POST /api/brain/roles/:role", () => {
  test("writes brain.roles.review via the same runBrainSet the command uses", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "qoder", model: "qoder-turbo" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect((readConfig().brain as any).roles.review).toEqual({
      provider: "qoder",
      model: "qoder-turbo",
    });
  });

  test("omits model when not provided", async () => {
    const app = buildApp();
    await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "agy" }),
    });
    expect((readConfig().brain as any).roles.review).toEqual({ provider: "agy" });
  });

  test("bad family -> 400, writes nothing", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "gpt5" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("bad role -> 400, writes nothing", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/banana", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "claude" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("missing family -> 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("without the secret -> 401, no write", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ family: "qoder" }),
    });
    expect(res.status).toBe(401);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });
});

describe("POST /api/brain/review-by-builder/:builder (Brain select v2 T3)", () => {
  test("writes brain.review_by_builder via the same setReviewByBuilder", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/review-by-builder/codex", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "claude", model: "claude-sonnet-4-6" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
    });
  });

  test("omits model when not provided", async () => {
    const app = buildApp();
    await app.request("/api/brain/review-by-builder/codex", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "codex" }),
    });
    expect((readConfig().brain as any).review_by_builder.codex).toEqual({ provider: "codex" });
  });

  test("model on a non-claude reviewer -> 400, no write", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/review-by-builder/codex", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "agy", model: "x" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("bad builder -> 400, no write", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/review-by-builder/gpt5", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "claude" }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("without the secret -> 401, no write", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/review-by-builder/codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewer: "claude" }),
    });
    expect(res.status).toBe(401);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });
});

describe("GET /api/brain includes v2 fields (T3)", () => {
  test("returns reviewByBuilder (5 rows) + claudeModels", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain");
    const json = (await res.json()) as {
      reviewByBuilder: { builder: string }[];
      claudeModels: string[];
    };
    expect(json.reviewByBuilder.length).toBe(5);
    expect(json.claudeModels.length).toBeGreaterThan(0);
  });
});
