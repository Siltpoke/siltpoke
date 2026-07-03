/**
 * dashboard-route.test.ts — POST /api/action unit tests.
 *
 * Covers:
 *   1. Accept: application/json (default) — existing JSON shape regression pin.
 *   2. Accept: text/html — rendered Hero fragment + HX-Trigger header.
 *   3. Invalid action validation.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountDashboardRoutes } from "../../src/daemon/routes/dashboard";

function makeApp(): { app: Hono; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-test-"));
  const app = new Hono();
  mountDashboardRoutes(app, { homeBase: dir });
  return { app, dir };
}

// ─── JSON regression-pin (Accept: application/json / no Accept) ───────────────

describe("POST /api/action — JSON response (regression pin)", () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = makeApp());
  });

  test("returns 200 JSON with ok:true for valid action (feed)", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "feed" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.action).toBe("feed");
    expect(typeof json.level).toBe("number");
    expect(typeof json.xp).toBe("number");
    expect(typeof json.xp_to_next_level).toBe("number");
    expect(typeof json.awarded).toBe("number");
    expect(typeof json.capped).toBe("boolean");
    expect(typeof json.grumpy).toBe("boolean");
    expect(typeof json.action_count).toBe("number");
    expect(typeof json.tease_count).toBe("number");
  });

  test("returns 200 JSON for play action", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "play" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.action).toBe("play");
  });

  test("returns 200 JSON for pet action", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pet" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.action).toBe("pet");
  });

  test("returns 200 JSON for tease action", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tease" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.action).toBe("tease");
  });

  test("returns 200 JSON for clean action (Wave 1.5b)", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clean" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.action).toBe("clean");
  });

  test("returns 200 JSON for sleep action (Wave 1.5b)", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sleep" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.action).toBe("sleep");
  });

  test("returns 400 JSON for invalid action", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "explode" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBeTruthy();
  });

  test("returns 400 JSON for invalid JSON body", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("no Accept header uses JSON path (content-type is application/json)", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "feed" }),
    });
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
  });
});

// ─── HTML Accept-negotiation path ───────────────────────────────────────────

describe("POST /api/action — text/html Accept (Accept negotiation)", () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = makeApp());
  });

  test("returns 200 text/html response when Accept: text/html", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "feed" }),
    });
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/html");
  });

  test("response body contains <section id='hero'> for hx-target anchor", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "feed" }),
    });
    const body = await res.text();
    expect(body).toContain('<section');
    expect(body).toContain('id="hero"');
  });

  test("HX-Trigger header is present", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "feed" }),
    });
    const trigger = res.headers.get("HX-Trigger-After-Swap");
    expect(trigger).not.toBeNull();
    expect(trigger).toBeTruthy();
  });

  test("HX-Trigger header contains 'action-result' key", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "feed" }),
    });
    const trigger = res.headers.get("HX-Trigger-After-Swap") ?? "";
    const parsed = JSON.parse(trigger) as Record<string, unknown>;
    expect(parsed["action-result"]).toBeDefined();
  });

  test("HX-Trigger action-result payload contains level", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "pet" }),
    });
    const trigger = res.headers.get("HX-Trigger-After-Swap") ?? "";
    const parsed = JSON.parse(trigger) as { "action-result": { level: number; mood: string } };
    expect(typeof parsed["action-result"].level).toBe("number");
  });

  test("HX-Trigger action-result payload contains mood", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "play" }),
    });
    const trigger = res.headers.get("HX-Trigger-After-Swap") ?? "";
    const parsed = JSON.parse(trigger) as { "action-result": { mood: string } };
    expect(typeof parsed["action-result"].mood).toBe("string");
  });

  test("body contains action chips (feed/play/pet hx-post)", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html",
      },
      body: JSON.stringify({ action: "feed" }),
    });
    const body = await res.text();
    expect(body).toContain('hx-post="/api/action"');
  });

  test("non-text/html Accept falls through to JSON (regression safety)", async () => {
    const res = await app.request("/api/action", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ action: "feed" }),
    });
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });
});
