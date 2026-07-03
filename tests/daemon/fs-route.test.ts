/**
 * GET /api/fs/list. Secret-gated, allow-root-sandboxed directory
 * browser. Asserts: fail-closed auth, validateListDir wiring + reasons, the
 * no-escape parent:null at the allow-root, and the listing/isCodebase payload.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountFsRoutes } from "../../src/daemon/routes/fs";

const SECRET = "test-secret-token";
let allowRoot: string;
let home: string;

beforeEach(() => {
  allowRoot = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-fs-root-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-fs-home-")));
  writeFileSync(join(home, "config.json"), JSON.stringify({ index: { allowRoots: [allowRoot] } }));
});
afterEach(() => {
  rmSync(allowRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeApp(): Hono {
  const app = new Hono();
  mountFsRoutes(app, { home, secret: SECRET });
  return app;
}
function get(app: Hono, query: string, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["X-Siltpoke-Secret"] = secret;
  return Promise.resolve(app.fetch(new Request(`http://localhost/api/fs/list${query}`, { headers })));
}

describe("GET /api/fs/list — auth + validation", () => {
  test("missing secret → 401", async () => {
    expect((await get(makeApp(), "", null)).status).toBe(401);
  });
  test("wrong secret → 401", async () => {
    expect((await get(makeApp(), "", "nope")).status).toBe(401);
  });
  test("dir outside the allow-root → 400 outside_allow_root", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-fs-out-")));
    const res = await get(makeApp(), `?dir=${encodeURIComponent(outside)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("outside_allow_root");
    rmSync(outside, { recursive: true, force: true });
  });
  test("relative dir → 400 not_absolute", async () => {
    expect((await get(makeApp(), "?dir=rel/dir")).status).toBe(400);
  });
  test("a file as dir → 400 not_a_directory", async () => {
    const f = join(allowRoot, "file.ts");
    writeFileSync(f, "x");
    expect((await get(makeApp(), `?dir=${encodeURIComponent(f)}`)).status).toBe(400);
  });
  test("traversal dir → refused (not 200)", async () => {
    const res = await get(makeApp(), `?dir=${encodeURIComponent(join(allowRoot, "..", ".."))}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/fs/list — listing + no-escape", () => {
  test("omitted dir → lists the allow-root; parent is null (no escape above)", async () => {
    mkdirSync(join(allowRoot, "alpha"));
    mkdirSync(join(allowRoot, "beta"));
    const res = await get(makeApp(), "");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.dir).toBe(allowRoot);
    expect(data.parent).toBeNull(); // at the allow-root → cannot go up
    expect(data.entries.map((e: { name: string }) => e.name)).toEqual(["alpha", "beta"]);
  });

  test("a child dir → parent is the allow-root (contained), navigable up", async () => {
    const child = join(allowRoot, "proj");
    mkdirSync(child);
    const { data } = await (await get(makeApp(), `?dir=${encodeURIComponent(child)}`)).json();
    expect(data.dir).toBe(child);
    expect(data.parent).toBe(allowRoot); // up stays within the allow-root
  });

  test("isCodebase reflects a marker in the dir + per-entry badge", async () => {
    const proj = join(allowRoot, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(allowRoot, "plain"));
    const { data } = await (await get(makeApp(), "")).json();
    const byName = Object.fromEntries(data.entries.map((e: { name: string; isCodebase: boolean }) => [e.name, e.isCodebase]));
    expect(byName.proj).toBe(true);
    expect(byName.plain).toBe(false);
    // and the dir-level flag for the child itself
    const childData = (await (await get(makeApp(), `?dir=${encodeURIComponent(proj)}`)).json()).data;
    expect(childData.isCodebase).toBe(true);
  });

  test("Index gate is markers-only: a lone-source-file dir badges but its gate is off", async () => {
    const dl = join(allowRoot, "downloads");
    mkdirSync(dl);
    writeFileSync(join(dl, "db_schema.py"), "x");
    // browse badge (broad) on the entry → true
    const listData = (await (await get(makeApp(), "")).json()).data;
    const dlEntry = listData.entries.find((e: { name: string }) => e.name === "downloads");
    expect(dlEntry.isCodebase).toBe(true);
    // but navigating INTO it: the dir gate (markers-only) → false (soft-block)
    const into = (await (await get(makeApp(), `?dir=${encodeURIComponent(dl)}`)).json()).data;
    expect(into.isCodebase).toBe(false);
  });
});
