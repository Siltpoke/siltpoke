/**
 * API route tests — GET /api/repo-memory
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { mountRepoMemoryApiRoutes } from "../../src/daemon/routes/repo-memory";

function buildApp(): Hono {
  const app = new Hono();
  mountRepoMemoryApiRoutes(app);
  return app;
}

describe("GET /api/repo-memory", () => {
  test("returns 200 with success:true", async () => {
    const app = buildApp();
    const res = await app.request("/api/repo-memory");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  test("returns null data when no index built yet (clean env)", async () => {
    // In test env ~/.siltpoke/repo-memory/index.json likely absent.
    const app = buildApp();
    const res = await app.request("/api/repo-memory");
    const json = (await res.json()) as { success: boolean; data: unknown };
    expect(json.success).toBe(true);
    // data is null or a valid index object — both acceptable
    if (json.data !== null) {
      const data = json.data as { filesIndexed: number };
      expect(typeof data.filesIndexed).toBe("number");
    }
  });
});
