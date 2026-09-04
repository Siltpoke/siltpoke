import { test, expect, describe, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountMemoryRoutes } from "../../../src/web/routes/memory";

// An isolated tmp homeBase (no `projects/` dir, no pin file) resolves to
// source "none" (proj_hash null) — the daemon's one-time `?repo=` seed
// redirect (added alongside the ResolvedContextBadge) only fires when a
// project actually resolves, so a bare "/memory" request here still renders
// synchronously instead of 302-ing. Using the default homeBase (the real
// machine's ~/.siltpoke) would make these tests depend on whatever real
// projects happen to be registered on the dev machine — isolating it fixes
// that latent fragility too.
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("GET /memory route", () => {
  function makeApp(): Hono {
    const homeBase = mkdtempSync(join(tmpdir(), "siltpoke-memory-route-"));
    dirs.push(homeBase);
    const app = new Hono();
    mountMemoryRoutes(app, { homeBase });
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
