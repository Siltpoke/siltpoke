/**
 * POST /api/repo-graph/index (+ /cancel). Drives the endpoint
 * with an injected indexRunner (deterministic, no real subprocess; the real
 * spawn is covered by a live Playwright smoke). Asserts: secret-gate, path
 * validation, spawn-on-realPath (not raw), one-at-a-time 409, SSE progress feed
 * (started → progress* → done | error), and cancel → kill + cleanup.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes, type IndexRunner } from "../../src/daemon/routes/repo-graph";
import { computeProjHash } from "../../src/repo-graph/proj-hash";

const SECRET = "test-secret-token";
let allowRoot: string;
let proj: string;
let home: string;

beforeEach(() => {
  allowRoot = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-idx-root-")));
  proj = join(allowRoot, "proj");
  mkdirSync(proj, { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-idx-home-")));
  writeFileSync(join(home, "config.json"), JSON.stringify({ index: { allowRoots: [allowRoot] } }));
});

afterEach(() => {
  rmSync(allowRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeApp(runner: IndexRunner): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: proj, home, secret: SECRET, indexRunner: runner });
  return app;
}

function post(app: Hono, path: string, body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Siltpoke-Secret"] = secret;
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  );
}
const postIndex = (app: Hono, body: unknown, secret: string | null = SECRET) =>
  post(app, "/api/repo-graph/index", body, secret);

/** Parse an SSE response body into `{event,data}` records. */
async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text();
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    const ev = /event:\s*(.+)/.exec(block);
    const dt = /data:\s*(.+)/.exec(block);
    if (ev && dt) {
      let data: unknown = dt[1];
      try {
        data = JSON.parse(dt[1]!);
      } catch {
        /* leave raw */
      }
      out.push({ event: ev[1]!.trim(), data });
    }
  }
  return out;
}

const okRunner: IndexRunner = async () => ({ exitCode: 0, timedOut: false, aborted: false });

describe("POST /index — auth + validation (pre-stream JSON)", () => {
  test("missing secret → 401", async () => {
    expect((await postIndex(makeApp(okRunner), { path: proj }, null)).status).toBe(401);
  });
  test("wrong secret → 401", async () => {
    expect((await postIndex(makeApp(okRunner), { path: proj }, "nope")).status).toBe(401);
  });
  test("invalid JSON → 400 invalid_json", async () => {
    const res = await postIndex(makeApp(okRunner), "{ not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });
  test("path outside allow-root → 400, runner never called", async () => {
    let called = false;
    const spy: IndexRunner = async () => {
      called = true;
      return { exitCode: 0, timedOut: false, aborted: false };
    };
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-idx-out-")));
    const res = await postIndex(makeApp(spy), { path: outside });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("outside_allow_root");
    expect(called).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
  test("relative path → 400 not_absolute", async () => {
    const res = await postIndex(makeApp(okRunner), { path: "rel/dir" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_absolute");
  });
});

describe("POST /index — SSE feed + spawn contract", () => {
  test("valid path → SSE started→progress→done; runner gets CANONICAL realPath", async () => {
    let seen: { realPath: string; projHash: string } | null = null;
    const spy: IndexRunner = async (args) => {
      seen = { realPath: args.realPath, projHash: args.projHash };
      args.onProgress?.(0, 2);
      args.onProgress?.(2, 2);
      return { exitCode: 0, timedOut: false, aborted: false };
    };
    const res = await postIndex(makeApp(spy), { path: join(proj, ".") + "/" }); // non-canonical input
    expect(res.status).toBe(200);
    const events = await readSSE(res);
    expect(events[0]!.event).toBe("started");
    expect(events.some((e) => e.event === "progress")).toBe(true);
    expect(events.at(-1)!.event).toBe("done");
    expect((events.at(-1)!.data as { hash: string }).hash).toMatch(/^[0-9a-f]{12}$/);
    // started comes before any progress ("scanning…" gap is client-side)
    expect(events.findIndex((e) => e.event === "started")).toBeLessThan(events.findIndex((e) => e.event === "progress"));
    expect(seen!.realPath).toBe(proj); // canonical, not "/proj/./"
  });

  // Maintenance round #2: a successful index is the re-attach point for a
  // paid arch-model stashed by a prior forget (removeRepoIndex preservation).
  test("done path restores a preserved paid arch-model into the fresh index dir", async () => {
    const hash = computeProjHash(proj);
    const stash = join(home, "repo-memory", ".preserved", hash);
    mkdirSync(stash, { recursive: true });
    writeFileSync(join(stash, "arch-model.json"), JSON.stringify({ paid: true }));
    // Stub mimics the real runner's observable side effect: the storage dir
    // exists after a successful build (restore needs a target to move into).
    const writerRunner: IndexRunner = async (args) => {
      mkdirSync(join(home, "repo-memory", args.projHash), { recursive: true });
      return { exitCode: 0, timedOut: false, aborted: false };
    };
    const events = await readSSE(await postIndex(makeApp(writerRunner), { path: proj }));
    expect(events.at(-1)!.event).toBe("done");
    expect(
      JSON.parse(readFileSync(join(home, "repo-memory", hash, "arch-model.json"), "utf8")),
    ).toEqual({ paid: true });
    expect(existsSync(stash)).toBe(false); // stash emptied after re-attach
  });

  test("non-clean exit → SSE error(index_failed) + partial index deleted", async () => {
    const failRunner: IndexRunner = async ({ projHash, home: h }) => {
      const dir = join(h!, "repo-memory", projHash);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ building: true }));
      return { exitCode: 1, timedOut: false, aborted: false };
    };
    const res = await postIndex(makeApp(failRunner), { path: proj });
    const events = await readSSE(res);
    expect(events.at(-1)!.event).toBe("error");
    expect((events.at(-1)!.data as { message: string }).message).toBe("index_failed");
    expect(existsSync(join(home, "repo-memory", computeProjHash(proj)))).toBe(false);
  });

  test("timeout → SSE error(timeout) + cleanup", async () => {
    const timeoutRunner: IndexRunner = async ({ projHash, home: h }) => {
      mkdirSync(join(h!, "repo-memory", projHash), { recursive: true });
      return { exitCode: null, timedOut: true, aborted: false };
    };
    const events = await readSSE(await postIndex(makeApp(timeoutRunner), { path: proj }));
    expect((events.at(-1)!.data as { message: string }).message).toBe("timeout");
    expect(existsSync(join(home, "repo-memory", computeProjHash(proj)))).toBe(false);
  });
});

describe("POST /index — one-at-a-time + cancel", () => {
  test("second index while one runs → 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocking: IndexRunner = async () => {
      await gate;
      return { exitCode: 0, timedOut: false, aborted: false };
    };
    const app = makeApp(blocking);
    const first = postIndex(app, { path: proj });
    await new Promise((r) => setTimeout(r, 20));
    const second = await postIndex(app, { path: proj });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("index_in_progress");
    release();
    await readSSE(await first);
  });

  test("cancel → child aborted, SSE error(cancelled), no partial repo", async () => {
    // runner that seeds a partial dir then resolves only when the signal aborts
    const cancellableRunner: IndexRunner = async ({ projHash, home: h, signal }) => {
      mkdirSync(join(h!, "repo-memory", projHash), { recursive: true });
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve());
      });
      return { exitCode: null, timedOut: false, aborted: true };
    };
    const app = makeApp(cancellableRunner);
    const indexing = postIndex(app, { path: proj });
    await new Promise((r) => setTimeout(r, 20));
    const cancelRes = await post(app, "/api/repo-graph/index/cancel", { hash: computeProjHash(proj) });
    expect((await cancelRes.json()).data.cancelled).toBe(true);
    const events = await readSSE(await indexing);
    expect((events.at(-1)!.data as { message: string }).message).toBe("cancelled");
    expect(existsSync(join(home, "repo-memory", computeProjHash(proj)))).toBe(false);
  });

  test("cancel with nothing running → cancelled:false", async () => {
    const res = await post(makeApp(okRunner), "/api/repo-graph/index/cancel", { hash: "abcdef012345" });
    expect((await res.json()).data.cancelled).toBe(false);
  });

  test("cancel without secret → 401", async () => {
    const res = await post(makeApp(okRunner), "/api/repo-graph/index/cancel", { hash: "x" }, null);
    expect(res.status).toBe(401);
  });

  test("lock released after completion → later index succeeds", async () => {
    const app = makeApp(okRunner);
    expect((await readSSE(await postIndex(app, { path: proj }))).at(-1)!.event).toBe("done");
    expect((await readSSE(await postIndex(app, { path: proj }))).at(-1)!.event).toBe("done");
  });
});

describe("DELETE /api/repo-graph/repos/:hash — forget", () => {
  const HASH = "abcdef012345";
  function del(app: Hono, hash: string, secret: string | null = SECRET): Promise<Response> {
    const headers: Record<string, string> = {};
    if (secret !== null) headers["X-Siltpoke-Secret"] = secret;
    return Promise.resolve(app.fetch(new Request(`http://localhost/api/repo-graph/repos/${hash}`, { method: "DELETE", headers })));
  }
  function seedRepo(hash: string): string {
    const dir = join(home, "repo-memory", hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ building: false }));
    return dir;
  }

  test("missing secret → 401", async () => {
    expect((await del(makeApp(okRunner), HASH, null)).status).toBe(401);
  });
  test("malformed hash → 400 invalid_hash (no rm)", async () => {
    const res = await del(makeApp(okRunner), "..%2f..%2fetc");
    expect(res.status).toBe(400);
  });
  test("valid hash → removes the index dir, removed:true", async () => {
    const dir = seedRepo(HASH);
    const res = await del(makeApp(okRunner), HASH);
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
  test("missing dir → removed:false (idempotent)", async () => {
    const res = await del(makeApp(okRunner), HASH);
    expect((await res.json()).data.removed).toBe(false);
  });
  test("blocked while an index runs → 409 guardrail", async () => {
    seedRepo(HASH);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocking: IndexRunner = async () => {
      await gate;
      return { exitCode: 0, timedOut: false, aborted: false };
    };
    const app = makeApp(blocking);
    const indexing = postIndex(app, { path: proj });
    await new Promise((r) => setTimeout(r, 20));
    const res = await del(app, HASH);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("index_in_progress");
    release();
    await readSSE(await indexing);
  });
});
