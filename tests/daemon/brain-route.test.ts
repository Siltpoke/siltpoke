// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tests for the brain-select route (Slice C / Task 8).
 *
 *   GET  /api/brain                 -> resolved brain view (read-only)
 *   POST /api/brain/roles/:role     -> set brain.roles[role] (secret-gated)
 *
 * The POST reuses the SAME `runBrainSet` the `/siltpoke:siltpoke-brain` command calls,
 * so the dashboard and the command are one source of truth by construction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, } from "node:fs";
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

  // Spec brain-select-four-gaps §3.1: the refusal follows the reviewer's real
  // argv, not "is it claude" — agy carries --model, so this pin is legitimate.
  test("model on a reviewer whose argv carries one (agy) -> 200, written", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/review-by-builder/codex", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "agy", model: "gemini-3-pro" }),
    });
    expect(res.status).toBe(200);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.brain.review_by_builder.codex).toEqual({
      provider: "agy",
      model: "gemini-3-pro",
    });
  });

  test("model on codex -> saved (its argv carries -m)", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/review-by-builder/agy", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "codex", model: "gpt-5.6-luna" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(home, "config.json"))).toBe(true);
  });

  test("role route: model on codex -> saved", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "codex", model: "gpt-5.6-luna" }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(home, "config.json"))).toBe(true);
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

// Spec brain-select-four-gaps §3.2: the dashboard's half of "undo the global
// pin". The CLI got `siltpoke brain unset <role>`; without this route the
// dashboard could pin a reviewer and never take it back, which is how the
// setting became one-way in the first place.
describe("DELETE /api/brain/roles/:role — undo a global pin", () => {
  test("removes the pin so the per-builder rule applies again", async () => {
    const app = buildApp();
    await app.request("/api/brain/review-by-builder/codex", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reviewer: "agy" }),
    });
    await app.request("/api/brain/roles/review", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "qoder" }),
    });
    expect(
      JSON.parse(readFileSync(join(home, "config.json"), "utf8")).brain.roles.review,
    ).toEqual({ provider: "qoder" });

    const res = await app.request("/api/brain/roles/review", {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(cfg.brain.roles.review).toBeUndefined();
    expect(cfg.brain.review_by_builder.codex).toEqual({ provider: "agy" });
  });

  test("unknown role -> 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/banana", {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(400);
  });

  test("no secret -> 401, no write", async () => {
    const app = buildApp();
    const res = await app.request("/api/brain/roles/review", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });
});

// Defect [49], AC13; spec §12.3 — the Settings page's three daily caps (one per role).
describe("POST /api/brain/daily-caps", () => {
  const post = (body: unknown, headers = authHeaders()): Promise<Response> =>
    Promise.resolve(
      buildApp().request("/api/brain/daily-caps", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  test("writes all three caps and returns them", async () => {
    const res = await post({ review: 80, chat: 0, extract: 7 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, review: 80, chat: 0, extract: 7 });
    expect(readConfig().brain).toEqual({ quota_daily_cap: 80, chat_quota_daily_cap: 0, extract_quota_daily_cap: 7 });
  });

  test("without the secret: 401 and nothing written", async () => {
    const res = await post({ review: 80, chat: 80, extract: 80 }, { "Content-Type": "application/json" });
    expect(res.status).toBe(401);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("with a wrong secret: 401 and nothing written", async () => {
    const res = await post(
      { review: 80, chat: 80, extract: 80 },
      { "Content-Type": "application/json", "X-Siltpoke-Secret": "nope" },
    );
    expect(res.status).toBe(401);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("a bad number: 400, says which cap, nothing written", async () => {
    const res = await post({ review: 80, chat: -1, extract: 5 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("chat");
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("a missing cap or a body that is not JSON: 400, nothing written", async () => {
    expect((await post({ review: 80 })).status).toBe(400);
    expect((await post({ review: 80, chat: 80 })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post("null")).status).toBe(400);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("leaves the role pins alone", async () => {
    await buildApp().request("/api/brain/roles/chat", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ family: "codebuddy" }),
    });
    await post({ review: 3, chat: 4, extract: 5 });
    expect(readConfig().brain).toEqual({
      roles: { chat: { provider: "codebuddy" } },
      quota_daily_cap: 3,
      chat_quota_daily_cap: 4,
      extract_quota_daily_cap: 5,
    });
  });
});
