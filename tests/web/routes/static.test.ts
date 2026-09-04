import { test, expect, describe } from "bun:test";
import { inflateSync } from "node:zlib";
import { decodePngRgba, meanInk, pngSize } from "./_png";
import { Hono } from "hono";
import { join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Layout } from "../../../src/web/_shared/layout";
import { mountExplainRoutes } from "../../../src/daemon/routes/explain";
import { cacheKey, writeExplanation } from "../../../src/explain/store";
import { EXPLANATION_SCHEMA_VERSION } from "../../../src/explain/types";
import {
  mountStaticRoutes,
  ensureClientBundle,
  bundleStale,
  resolveRepoRoot,
} from "../../../src/web/routes/static";

// The real repo root, derived from this test file's own location
// (<root>/tests/web/routes/static.test.ts → 3 up). Used to exercise
// resolveRepoRoot against real on-disk directories (no mocks).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

describe("static routes", () => {
  describe("resolveRepoRoot (survives source AND bundled/dist layout)", () => {
    test("bundled: here=<root>/dist resolves to the real repo root", () => {
      // The launchd daemon runs dist/siltpoke-daemon.js, so `here` = <root>/dist.
      // The old 3-up guess overshot to <root>/../.. (ai-agents/) → every
      // /static/* 503. Walking up to package.json lands on the real root.
      expect(resolveRepoRoot(join(REPO_ROOT, "dist"))).toBe(REPO_ROOT);
    });

    test("source: here=<root>/src/web/routes resolves to the real repo root", () => {
      // `bun run report` runs from source; must NOT regress.
      expect(resolveRepoRoot(join(REPO_ROOT, "src", "web", "routes"))).toBe(
        REPO_ROOT,
      );
    });
  });

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

    test("does NOT build when the bundle exists and is fresh", async () => {
      let buildCalls = 0;
      // This test file itself is a guaranteed-present path.
      const res = await ensureClientBundle({
        bundlePath: import.meta.path,
        isStale: () => false,
        build: async () => {
          buildCalls++;
          return { success: true };
        },
      });
      expect(buildCalls).toBe(0);
      expect(res.built).toBe(false);
    });

    test("REBUILDS when the bundle exists but is stale (edited island source)", async () => {
      let buildCalls = 0;
      const res = await ensureClientBundle({
        bundlePath: import.meta.path, // present, but…
        isStale: () => true, // …a client source file is newer than it
        build: async () => {
          buildCalls++;
          return { success: true };
        },
      });
      expect(buildCalls).toBe(1);
      expect(res.built).toBe(true);
    });

    describe("bundleStale (mtime staleness check)", () => {
      const tmp = mkdtempSync(join(tmpdir(), "siltpoke-stale-"));
      const bundle = join(tmp, "index.js");
      const src = join(tmp, "src");
      const srcFile = join(src, "island.ts");
      writeFileSync(bundle, "// bundle");
      mkdirSync(src, { recursive: true });
      writeFileSync(srcFile, "// island");

      test("missing bundle → stale", () => {
        expect(bundleStale(join(tmp, "nope.js"), src)).toBe(true);
      });

      test("absent src tree → NOT stale (installed package: shipped bundle wins)", () => {
        expect(bundleStale(bundle, join(tmp, "no-such-src"))).toBe(false);
      });

      test("a src file newer than the bundle → stale", () => {
        // bundle at T, src file at T+10s
        const now = Date.now() / 1000;
        utimesSync(bundle, now, now);
        utimesSync(srcFile, now + 10, now + 10);
        expect(bundleStale(bundle, src)).toBe(true);
      });

      test("all src older than the bundle → NOT stale", () => {
        const now = Date.now() / 1000;
        utimesSync(srcFile, now - 10, now - 10);
        utimesSync(bundle, now, now);
        expect(bundleStale(bundle, src)).toBe(false);
      });

      test("fails safe: a walk error (srcDir is a file, not a dir) → NOT stale, never throws", () => {
        // readdirSync on a file throws ENOTDIR; the catch must swallow it so
        // daemon startup can't crash on a transient fs error.
        expect(() => bundleStale(bundle, srcFile)).not.toThrow();
        expect(bundleStale(bundle, srcFile)).toBe(false);
      });

      test("cleanup", () => {
        rmSync(tmp, { recursive: true, force: true });
        expect(true).toBe(true);
      });
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

  describe("brand icons", () => {
    // `sizes="NxN"` in the <link> is a promise about the file, and nothing
    const ICONS: Array<{ route: string; file: string; size: number }> = [
      { route: "/static/favicon-light.png", file: "favicon-light.png", size: 64 },
      { route: "/static/favicon-dark.png", file: "favicon-dark.png", size: 64 },
      { route: "/static/apple-touch-icon.png", file: "apple-touch-icon.png", size: 180 },
    ];

    test("the two tab variants are inverse in ink, not merely different files", async () => {
      // The whole point of shipping two. Emitting the same glyph twice, or
      // swapping which is which, produces two valid PNGs of plausible size
      // that serve 200 — no assertion about bytes or dimensions can tell.
      const app = new Hono();
      mountStaticRoutes(app);
      const ink = async (route: string): Promise<number> => {
        const bytes = new Uint8Array(await (await app.request(route)).arrayBuffer());
        return meanInk(decodePngRgba(bytes, inflateSync));
      };
      expect(await ink("/static/favicon-light.png")).toBeLessThan(40);
      expect(await ink("/static/favicon-dark.png")).toBeGreaterThan(215);
    });

    for (const icon of ICONS) {
      test(`GET ${icon.route} serves the real ${icon.size}px asset`, async () => {
        const app = new Hono();
        mountStaticRoutes(app);
        const res = await app.request(icon.route);
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("image/png");
        expect(res.headers.get("Cache-Control")).toMatch(/max-age=\d+/);

        const served = new Uint8Array(await res.arrayBuffer());
        // Non-empty FIRST: two empty buffers compare equal, so a byte-equality
        // assertion on its own would pass just as loudly if the route served
        // nothing and the file on disk were also empty (lessons: an empty-set
        // comparison is not evidence).
        expect(served.byteLength).toBeGreaterThan(0);
        expect(Array.from(served.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(pngSize(served)).toEqual({ width: icon.size, height: icon.size });

        const onDisk = new Uint8Array(
          readFileSync(join(REPO_ROOT, "src", "web", "assets", icon.file)),
        );
        expect(served.byteLength).toBe(onDisk.byteLength);
        expect(Buffer.from(served).equals(Buffer.from(onDisk))).toBe(true);
      });

      test(`${icon.file} is tracked by git (git archive ships the tarball)`, () => {
        // scripts/pack-dist.sh builds the release tarball with `git archive`,
        // which ships TRACKED files only. Moving these into public/static/
        // would keep every local test green and ship a release whose dashboard
        // has no icon. `--error-unmatch` exits non-zero on an untracked path.
        const rel = `src/web/assets/${icon.file}`;
        const proc = Bun.spawnSync({
          cmd: ["git", "ls-files", "--error-unmatch", rel],
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(proc.exitCode).toBe(0);
      });
    }

    test("GET /favicon.ico redirects to the 32px icon", async () => {
      // Browsers request this implicitly on pages that declare no <link
      // rel=icon>; a redirect keeps one canonical URL per asset. 302 and NOT
      // 301: a permanent redirect is cached across browser restarts without
      // revalidation, so renaming the target later would strand every past
      // visitor with no server-side way to take it back.
      const app = new Hono();
      mountStaticRoutes(app);
      const res = await app.request("/favicon.ico");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/static/favicon-light.png");
    });

    // A served route nobody links to is wired but useless — so assert on
    // RENDERED HTML, not on the source text of the files that produce it. The
    // first version of this test grepped layout.tsx as a string, and was green
    // while two of the four standalone <head>s in explain.tsx — including
    // /explain/:id, the page a real explanation opens at — had no icon links
    // at all. A grep proves characters exist in a file; it cannot tell you
    // which of six heads they reached.
    function expectDeclaresIcons(html: string, where: string): void {
      // Non-empty first: `toContain` on "" would fail, but an almost-empty
      // error page would fail for a reason that has nothing to do with icons.
      expect(html.length, `${where}: rendered nothing`).toBeGreaterThan(200);
      expect(html, where).toContain('href="/static/favicon-light.png"');
      expect(html, where).toContain('sizes="64x64"');
      expect(html, where).toContain('href="/static/apple-touch-icon.png"');
      expect(html, where).toContain('sizes="180x180"');
      // Without the inline script the head is stuck on the light-mode glyph,
      // which on a dark tab bar is a black cat on black. A head that carries
      // the links but not the script looks complete and is half the feature.
      expect(html, where).toContain("prefers-color-scheme: dark");
      expect(html, where).toContain("/static/favicon-dark.png");
    }

    test("the dashboard Layout renders both icon links", async () => {
      // Layout is the single <head> every dashboard screen goes through.
      const html = await (Layout({ children: "body" }) as { toString(): string }).toString();
      expectDeclaresIcons(html, "Layout");
    });

    test("all four standalone <head>s in /explain render both icon links", async () => {
      // These bypass Layout entirely. Each is exercised through a real request
      // so the assertion covers the head that actually ships, including the
      // success path at /explain/:id.
      const home = mkdtempSync(join(tmpdir(), "siltpoke-icon-home-"));
      const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-icon-proj-"));
      try {
        const targetNodeId = "some/file.ts#someFunction";
        const key = cacheKey(targetNodeId);
        await writeExplanation(projectRoot, key, "body-markdown", {
          schemaVersion: EXPLANATION_SCHEMA_VERSION,
          target: "icon-fixture-target",
          target_node_id: targetNodeId,
          target_key_sha256: key,
          graph_indexed_ts: "2026-08-20T00:00:00.000Z",
          brain_usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_cost_usd: 0,
          },
          evidence_score: 1,
          low_confidence: false,
          depth: 1,
          created_ts: "2026-08-20T00:00:00.000Z",
        });

        const app = new Hono();
        mountExplainRoutes(app, {
          homeBase: home,
          cwd: projectRoot,
          secret: "",
          resolveProjectRoot: async () => projectRoot,
        });

        // A 12-hex id that is well-formed but has nothing on disk, so the
        // not-found head renders instead of the invalid-id one.
        const missingKey = "0".repeat(key.length);
        const cases: Array<[string, string, number]> = [
          ["/explain", "index", 200],
          ["/explain/not-hex!!", "invalid id", 400],
          [`/explain/${missingKey}`, "not found", 404],
          [`/explain/${key}`, "explanation page", 200],
        ];

        for (const [url, where, status] of cases) {
          const res = await app.request(url);
          expect(res.status, `${where} (${url})`).toBe(status);
          expectDeclaresIcons(await res.text(), `${where} (${url})`);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test("every standalone <head> in src/ goes through <BrandIcons />", async () => {
      // Drift guard for the NEXT head somebody writes. The two misses above
      // were not a logic error — they were a copy that did not get made, and
      // no behavioural test can cover a page that does not exist yet.
      const proc = Bun.spawnSync({
        // --untracked so a brand-new page file is covered on the run that
        // introduces it, not only after it has been `git add`ed.
        cmd: ["git", "grep", "-l", "--untracked", "--", "<head>", "src/"],
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      const files = new TextDecoder()
        .decode(proc.stdout)
        .split("\n")
        .filter((f) => f.endsWith(".tsx"));
      // If this ever hits zero the guard has stopped looking at anything.
      expect(files.length).toBeGreaterThan(0);

      for (const rel of files) {
        const src = readFileSync(join(REPO_ROOT, rel), "utf8");
        // Only lines that OPEN a head element — a prose mention of <head>
        // inside a comment is not a page. explain.tsx has four.
        const heads = src.match(/^\s*<head>\s*$/gm)?.length ?? 0;
        if (heads === 0) continue;
        // COUNT, not presence: `toContain` is satisfied by one occurrence, so
        // a file with four heads passes it while three of them are bare —
        // which is the exact shape of the bug this guard exists for.
        const icons = src.match(/<BrandIcons \/>/g)?.length ?? 0;
        expect(icons, `${rel} has ${heads} <head>(s) but ${icons} <BrandIcons />`).toBe(
          heads,
        );
      }
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
