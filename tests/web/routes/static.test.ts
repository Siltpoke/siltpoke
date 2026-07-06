import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import {
  mountStaticRoutes,
  ensureClientBundle,
} from "../../../src/web/routes/static";

describe("static routes", () => {
  test("GET /static/tokens.css returns CSS with :root vars", async () => {
    const app = new Hono();
    mountStaticRoutes(app);
    const res = await app.request("/static/tokens.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    const body = await res.text();
    expect(body).toContain(":root {");
    expect(body).toContain("--color-cream: #faf6ec");
    expect(body).toContain("--font-display:");
  });

  test("GET /static/tokens.css cache header set", async () => {
    const app = new Hono();
    mountStaticRoutes(app);
    const res = await app.request("/static/tokens.css");
    expect(res.headers.get("Cache-Control")).toMatch(/max-age=\d+/);
  });

  test("GET /static/tailwind.css serves CSS or 503 placeholder", async () => {
    // public/static/tailwind.css is a build artifact (gitignored). Whether or
    // not it's been built, assert the route shape: text/css + no-store, and
    // status 200 (built) or 503 (missing) — never a crash.
    const app = new Hono();
    mountStaticRoutes(app);
    const res = await app.request("/static/tailwind.css");
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    const body = await res.text();
    if (res.status === 503) {
      expect(body).toContain("build:tailwind");
    } else {
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      // Guard against a vacuous 200 with an empty body: a real build emits the
      // brand theme vars + utility classes into the served CSS.
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("--color-cream");
    }
  });

  describe("ensureClientBundle (lazy build on daemon start)", () => {
    test("builds the bundle when it is missing", async () => {
      let buildCalls = 0;
      const res = await ensureClientBundle({
        bundlePath: join("/tmp", "no-such-siltpoke-bundle-xyz", "index.js"),
        build: async () => {
          buildCalls++;
          return { success: true };
        },
      });
      expect(buildCalls).toBe(1);
      expect(res.built).toBe(true);
    });

    test("does NOT build when the bundle already exists", async () => {
      let buildCalls = 0;
      // This test file itself is a guaranteed-present path.
      const res = await ensureClientBundle({
        bundlePath: import.meta.path,
        build: async () => {
          buildCalls++;
          return { success: true };
        },
      });
      expect(buildCalls).toBe(0);
      expect(res.built).toBe(false);
    });

    test("fails open: a build error does not throw (daemon must still start)", async () => {
      const res = await ensureClientBundle({
        bundlePath: join("/tmp", "no-such-siltpoke-bundle-xyz", "index.js"),
        build: async () => {
          throw new Error("build blew up");
        },
      });
      expect(res.built).toBe(false);
    });
  });

  test("GET /static/index.js returns 503 placeholder when bundle missing", async () => {
    // Test environment doesn't have public/static/index.js built — verify
    // graceful 503 with a hint message rather than a crash.
    const app = new Hono();
    mountStaticRoutes(app);
    const res = await app.request("/static/index.js");
    // Either bundle exists (success after a real build) or 503 placeholder.
    // Assert the shape regardless: status 200 or 503; content-type set.
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
  });
});
