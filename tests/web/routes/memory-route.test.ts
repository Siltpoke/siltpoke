import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { mountMemoryRoutes } from "../../../src/web/routes/memory";

describe("GET /memory route", () => {
  function makeApp(): Hono {
    const app = new Hono();
    mountMemoryRoutes(app);
    return app;
  }

  test("returns 200", async () => {
    const app = makeApp();
    const res = await app.request("/memory");
    expect(res.status).toBe(200);
  });

  test("sets text/html content-type", async () => {
    const app = makeApp();
    const res = await app.request("/memory");
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
  });

  test("response body contains Memory nav label", async () => {
    const app = makeApp();
    const res = await app.request("/memory");
    const html = await res.text();
    expect(html).toContain("Memory");
  });

  test("response body contains memory-book container", async () => {
    const app = makeApp();
    const res = await app.request("/memory");
    const html = await res.text();
    expect(html).toContain('class="memory-book"');
  });

  test("response body contains memory-timeline container", async () => {
    const app = makeApp();
    const res = await app.request("/memory");
    const html = await res.text();
    expect(html).toContain('class="memory-timeline"');
  });

  test("other routes are unaffected (GET / returns 404 since not mounted)", async () => {
    const app = makeApp();
    const res = await app.request("/other-route");
    expect(res.status).toBe(404);
  });
});
