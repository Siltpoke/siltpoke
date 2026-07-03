/**
 * API route tests — GET /api/preference-log
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { mountPreferenceLogApiRoutes } from "../../src/daemon/routes/preference-log";

function buildApp(): Hono {
  const app = new Hono();
  mountPreferenceLogApiRoutes(app);
  return app;
}

describe("GET /api/preference-log", () => {
  test("returns 200 with success:true", async () => {
    const app = buildApp();
    const res = await app.request("/api/preference-log");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  test("returns expected shape: counts + entries + meta", async () => {
    const app = buildApp();
    const res = await app.request("/api/preference-log");
    const json = (await res.json()) as {
      success: boolean;
      data: {
        counts: Record<string, number>;
        entries: unknown[];
      };
      meta: { total: number; limit: number };
    };
    expect(typeof json.data.counts).toBe("object");
    expect(Array.isArray(json.data.entries)).toBe(true);
    expect(typeof json.meta.limit).toBe("number");
  });

  test("respects ?limit param", async () => {
    const app = buildApp();
    const res = await app.request("/api/preference-log?limit=5");
    const json = (await res.json()) as { meta: { limit: number } };
    expect(json.meta.limit).toBe(5);
  });
});
