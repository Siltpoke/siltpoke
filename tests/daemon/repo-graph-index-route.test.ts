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

// ─────────────────────────────────────────────────────────────────────────────
// The child's stderr must reach the SSE error event.
//
// `defaultIndexRunner` used to spawn with `stderr: "ignore"`. Combined with the
// dist/ path bug (see repo-graph-indexer-target.test.ts) that meant every
// dashboard index emitted `error: Module not found …` and the string went
// nowhere at all — no log, no UI. Capturing it is only half a fix; this pins
// the other half, that it survives the trip to the client.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// A failed or cancelled RE-index must not destroy the index already on disk.
//
// The route used to call removeRepoIndex unconditionally on every non-success
// outcome, which erased builder.ts's own cold-vs-reindex distinction — so a
// failed re-index threw away a working map, and so did pressing Cancel on one.
// The unit tests in tests/repo-graph/discard-failed-build.test.ts pin the
// DECISION; these pin that the route actually routes through it.
// ─────────────────────────────────────────────────────────────────────────────

describe("a non-success outcome preserves a prior good index", () => {
  /** Seed what markBuildStart leaves for a re-index: prior fields + building. */
  function seedPriorGood(hash: string): string {
    const dir = join(home, "repo-memory", hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        project_root: proj,
        proj_hash: hash,
        last_indexed_ts: "2026-08-01T10:00:00.000Z",
        counters: { files_walked: 9 },
        building: true,
      }),
    );
    writeFileSync(join(dir, "nodes.jsonl"), '{"id":"n1"}\n');
    return dir;
  }

  const hashOf = () => computeProjHash(proj);

  test("non-zero exit on a re-index keeps the graph and un-sticks building", async () => {
    const dir = seedPriorGood(hashOf());
    const failing: IndexRunner = async () => ({ exitCode: 1, timedOut: false, aborted: false });

    const events = await readSSE(await postIndex(makeApp(failing), { path: proj }));
    expect(events.find((e) => e.event === "error")).toBeDefined();

    // Pre-fix: the whole dir was removed, so this file was gone.
    expect(existsSync(join(dir, "nodes.jsonl"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.building).toBe(false);
    expect(meta.last_indexed_ts).toBe("2026-08-01T10:00:00.000Z");
  });

  test("CANCELLING a re-index costs nothing — the map survives", async () => {
    const dir = seedPriorGood(hashOf());
    const cancelled: IndexRunner = async () => ({ exitCode: null, timedOut: false, aborted: true });

    const events = await readSSE(await postIndex(makeApp(cancelled), { path: proj }));
    expect((events.find((e) => e.event === "error")?.data as { message?: string })?.message).toBe(
      "cancelled",
    );
    expect(existsSync(join(dir, "nodes.jsonl"))).toBe(true);
  });

  test("a COLD build that fails still leaves nothing behind — no stuck entry", async () => {
    // Negative control: the preserve behaviour must not resurrect the old bug
    // of a permanent "indexing…" ghost for a repo that never indexed.
    const hash = hashOf();
    const dir = join(home, "repo-memory", hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ schemaVersion: 1, proj_hash: hash, last_indexed_ts: "", building: true }),
    );
    const failing: IndexRunner = async () => ({ exitCode: 1, timedOut: false, aborted: false });

    await readSSE(await postIndex(makeApp(failing), { path: proj }));
    expect(existsSync(dir)).toBe(false);
  });
});

describe("index SSE carries the child's failure detail", () => {
  const failWithStderr = (stderrTail?: string): IndexRunner => {
    return async () => ({ exitCode: 1, timedOut: false, aborted: false, stderrTail });
  };

  test("non-zero exit → error event carries the last stderr line as `detail`", async () => {
    const raw = 'error: Module not found "/Users/v/ai-agents/siltpoke/cli/index-repo.ts"\n\n';
    const res = await postIndex(makeApp(failWithStderr(raw)), { path: proj });
    const events = await readSSE(res);
    const err = events.find((e) => e.event === "error");
    expect(err).toBeDefined();
    const data = err!.data as { message?: string; detail?: string };
    expect(data.message).toBe("index_failed");
    // The blank trailing line must not win, and the text must arrive intact.
    expect(data.detail).toBe('error: Module not found "/Users/v/ai-agents/siltpoke/cli/index-repo.ts"');
  });

  test("no stderr → no `detail` key invented", async () => {
    const res = await postIndex(makeApp(failWithStderr(undefined)), { path: proj });
    const events = await readSSE(res);
    const data = (events.find((e) => e.event === "error")!.data as { message?: string; detail?: string });
    expect(data.message).toBe("index_failed");
    expect(data.detail).toBeUndefined();
  });

  test("a TIMEOUT gets no detail — we killed it, so its stderr says nothing about the cause", async () => {
    const timedOut: IndexRunner = async () => ({
      exitCode: null,
      timedOut: true,
      aborted: false,
      stderrTail: "some noise the child happened to print before we killed it",
    });
    const res = await postIndex(makeApp(timedOut), { path: proj });
    const events = await readSSE(res);
    const data = (events.find((e) => e.event === "error")!.data as { message?: string; detail?: string });
    expect(data.message).toBe("timeout");
    // Positive control: the runner DID supply a stderrTail, so an undefined
    // detail here is a deliberate suppression, not an empty fixture.
    expect(data.detail).toBeUndefined();
  });
});
