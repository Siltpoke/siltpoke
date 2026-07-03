/**
 * API route tests — GET /api/rubric
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { mountRubricApiRoutes } from "../../src/daemon/routes/rubric";

function buildApp(): Hono {
  const app = new Hono();
  mountRubricApiRoutes(app);
  return app;
}

describe("GET /api/rubric", () => {
  test("returns 200 with success:true", async () => {
    const app = buildApp();
    const res = await app.request("/api/rubric");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  test("returns rules array with id, tier, languages fields", async () => {
    const app = buildApp();
    const res = await app.request("/api/rubric");
    const json = (await res.json()) as {
      success: boolean;
      data: {
        rules: Array<{ id: string; tier: number; languages: string[] }>;
        calibration: Record<string, number>;
      };
    };
    expect(Array.isArray(json.data.rules)).toBe(true);
    expect(json.data.rules.length).toBeGreaterThan(0);
    const first = json.data.rules[0]!;
    expect(typeof first.id).toBe("string");
    expect(typeof first.tier).toBe("number");
    expect(Array.isArray(first.languages)).toBe(true);
  });

  test("returns calibration object (may be empty if doc absent)", async () => {
    const app = buildApp();
    const res = await app.request("/api/rubric");
    const json = (await res.json()) as {
      data: { calibration: unknown };
    };
    expect(typeof json.data.calibration).toBe("object");
  });
});
