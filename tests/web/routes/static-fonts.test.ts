import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fontFaceCss } from "../../../src/web/client/export/fonts";
import { mountStaticRoutes } from "../../../src/web/routes/static";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
/** The vendored files, from disk — the route and fontFaceCss are both checked against them. */
const fontFiles = (): string[] =>
  readdirSync(join(REPO_ROOT, "public", "static", "fonts")).filter((f) => f.endsWith(".woff2")).sort();
/** The dashboard's own files (`Dash-*`, scripts/vendor-dashboard-fonts.ts) vs the share-export's. */
const isDashboardFont = (f: string): boolean => f.startsWith("Dash-");
const exportFontFiles = (): string[] => fontFiles().filter((f) => !isDashboardFont(f));

describe("GET /static/fonts/* (vendored export fonts)", () => {
  const fontsDir = join(REPO_ROOT, "public", "static", "fonts");
  const mount = () => {
    const app = new Hono();
    mountStaticRoutes(app);
    return app;
  };

  test("Geist-Regular.woff2 → 200, font/woff2, bytes equal the file on disk", async () => {
    const res = await mount().request("/static/fonts/Geist-Regular.woff2");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("font/woff2");
    const body = new Uint8Array(await res.arrayBuffer());
    const disk = readFileSync(join(fontsDir, "Geist-Regular.woff2"));
    expect(body.byteLength).toBeGreaterThan(1000);
    expect(body.byteLength).toBe(disk.byteLength);
    expect(Buffer.from(body).equals(disk)).toBe(true);
  });

  test("every vendored font file is actually served", async () => {
    expect(fontFiles().length).toBeGreaterThan(0);
    const app = mount();
    for (const file of fontFiles()) {
      const res = await app.request(`/static/fonts/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("font/woff2");
    }
  });

  test("traversal, other extensions and missing files → 404", async () => {
    const app = mount();
    for (const p of [
      "..%2F..%2Fpackage.json",
      "..%2F..%2F..%2Fpackage.json",
      "%2E%2E%2Fpackage.json",
      "x.js",
      "Geist-Regular.woff2.txt",
      "OFL-Geist.txt",
      "Nope-Missing.woff2",
      "..%2Ffonts%2FGeist-Regular.woff2",
    ]) {
      const res = await app.request(`/static/fonts/${p}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type") ?? "").not.toContain("font/woff2");
    }
  });
});

describe("GET /static/fonts/dashboard.css (the dashboard's own fonts)", () => {
  const app = () => {
    const a = new Hono();
    mountStaticRoutes(a);
    return a;
  };
  const urlsIn = (css: string): string[] => [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1] as string);

  test("200, CSS, and byte-equal to the file on disk", async () => {
    const res = await app().request("/static/fonts/dashboard.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    const disk = readFileSync(join(REPO_ROOT, "public", "static", "fonts", "dashboard.css"), "utf8");
    expect(await res.text()).toBe(disk);
  });

  test("every font it names is served from here, and it names no other site", async () => {
    const css = await (await app().request("/static/fonts/dashboard.css")).text();
    const urls = urlsIn(css);
    expect(urls.length).toBeGreaterThan(0); // positive control
    for (const family of ["Geist", "JetBrains Mono", "Pixelify Sans"]) {
      expect(css).toContain(`font-family: '${family}'`);
    }
    expect(css).toContain("font-display: swap");
    expect(css).not.toMatch(/https?:/);
    const a = app();
    for (const url of new Set(urls)) {
      expect(url).toMatch(/^\/static\/fonts\/Dash-[A-Za-z0-9-]+\.woff2$/);
      const res = await a.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("font/woff2");
    }
  });

  test("every Dash-* file on disk is named by the sheet (no orphan)", async () => {
    const css = await (await app().request("/static/fonts/dashboard.css")).text();
    const named = new Set(urlsIn(css).map((u) => u.split("/").pop()));
    const onDisk = fontFiles().filter(isDashboardFont);
    expect(onDisk.length).toBeGreaterThan(0);
    expect(onDisk.filter((f) => !named.has(f))).toEqual([]);
  });
});

describe("fontFaceCss through the real route", () => {
  test("every @font-face data URI decodes to the served file, byte for byte", async () => {
    const app = new Hono();
    mountStaticRoutes(app);
    const requested: string[] = [];
    const viaRoute = (async (input: RequestInfo | URL) => {
      requested.push(String(input).split("/").pop() as string);
      return app.request(String(input));
    }) as typeof fetch;

    const css = await fontFaceCss(viaRoute);
    const uris = [...css.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)].map((m) => m[1]);
    const files = exportFontFiles();
    expect(uris.length).toBe(files.length);
    expect([...requested].sort()).toEqual(files);
    // Rules come out in the module's order, so match each URI to its file by bytes.
    for (const file of files) {
      const disk = readFileSync(join(REPO_ROOT, "public", "static", "fonts", file));
      expect(uris.some((u) => Buffer.from(u as string, "base64").equals(disk))).toBe(true);
    }
  });
});

describe("GET /static/export-standalone.js (the script the HTML export inlines)", () => {
  const app = () => {
    const a = new Hono();
    mountStaticRoutes(a);
    return a;
  };
  const disk = readFileSync(join(REPO_ROOT, "public", "static", "export-standalone.js"), "utf8");

  test("200, JavaScript, no-store, and byte-equal to the built file", async () => {
    const res = await app().request("/static/export-standalone.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.text();
    expect(disk.length).toBeGreaterThan(1000); // positive control
    expect(body).toBe(disk);
  });

  test("the hashed-chunk route still refuses names that are not a chunk", async () => {
    for (const name of ["export-standalone2.js", "other-name.js", "index2.js"]) {
      expect((await app().request(`/static/${name}`)).status).toBe(404);
    }
  });
});
