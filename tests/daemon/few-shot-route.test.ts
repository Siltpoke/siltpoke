/**
 * API route tests — GET /api/few-shot
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { mountFewShotApiRoutes } from "../../src/daemon/routes/few-shot";

function buildApp(): Hono {
  const app = new Hono();
  mountFewShotApiRoutes(app);
  return app;
}

describe("GET /api/few-shot", () => {
  test("returns 200 with success:true", async () => {
    const app = buildApp();
    const res = await app.request("/api/few-shot");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  test("returns expected shape: totalEntries, embeddingDim, neighbors", async () => {
    const app = buildApp();
    const res = await app.request("/api/few-shot");
    const json = (await res.json()) as {
      success: boolean;
      data: {
        totalEntries: number;
        embeddingDim: number;
        oldestTs: string | null;
        newestTs: string | null;
        neighbors: unknown[];
      };
    };
    expect(typeof json.data.totalEntries).toBe("number");
    expect(typeof json.data.embeddingDim).toBe("number");
    expect(Array.isArray(json.data.neighbors)).toBe(true);
  });

  test("returns empty neighbors without ?q= param", async () => {
    const app = buildApp();
    const res = await app.request("/api/few-shot");
    const json = (await res.json()) as { data: { neighbors: unknown[] } };
    expect(json.data.neighbors).toHaveLength(0);
  });
});
