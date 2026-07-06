/**
 * Generate handler stopgap wiring: register (visible) + one-at-a-time lock
 * (409) + POST /arch/cancel → the registry records `cancelled` and the awaiting
 * generate returns 408. The subprocess truly dying is the registry's real-pid
 * test; here we prove the HANDLER drives that path correctly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";

const HASH = "deadbeef0001";
const tmps: string[] = [];

function seedHome(): { home: string; projectRoot: string } {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-gen-"));
  tmps.push(home);
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(home, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  const graph = { schemaVersion: 1, nodes: [{ id: "file:src/a/x.ts:", type: "file", name: "x.ts", path: "src/a/x.ts", lineRange: [1, 5] }], edges: [] };
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify(graph));
  writeFileSync(join(storageDir, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: projectRoot, proj_hash: HASH,
    last_indexed_ts: "2026-06-08T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 1, function: 0, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
  return { home, projectRoot };
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A Brain provider that blocks until its signal aborts (a slow `claude -p` stand-in). */
const blockingProvider: BrainProvider = ({ signal, onSpawn }) =>
  new Promise((_resolve, reject) => {
    onSpawn?.({ pid: 123456, kill: () => {} });
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

function mount(home: string) {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s", archBrainProvider: blockingProvider });
  return app;
}

describe("generate handler — stopgap wiring", () => {
  test("register writes a running task the moment generate starts (visible)", async () => {
    const { home } = seedHome();
    const app = mount(home);
    // fire generate (it blocks on the provider); don't await it
    const gen = app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    await new Promise((r) => setTimeout(r, 50)); // let it register + spawn
    const tasksFile = join(home, "tasks.json");
    expect(existsSync(tasksFile)).toBe(true);
    const tasks = JSON.parse(readFileSync(tasksFile, "utf8"));
    expect(tasks[0].status).toBe("running");        // start record (invisible-burn fix)
    expect(tasks[0].kind).toBe("arch_generate");
    // cancel so the blocked request resolves + the test ends clean
    await app.request("/api/repo-graph/arch/cancel", { method: "POST", headers: { "X-Siltpoke-Secret": "s" } });
    await gen;
  });

  test("a 2nd generate while one runs → 409 (one-at-a-time lock)", async () => {
    const { home } = seedHome();
    const app = mount(home);
    const gen1 = app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const res2 = await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    expect(res2.status).toBe(409); // busy
    await app.request("/api/repo-graph/arch/cancel", { method: "POST", headers: { "X-Siltpoke-Secret": "s" } });
    await gen1;
  });

  test("/arch/cancel → registry cancelled (detached: generate returned 202; cancel kills the background run)", async () => {
    const { home } = seedHome();
    const app = mount(home);
    // Detached: generate returns {taskId} 202 immediately (no longer awaits).
    const genRes = await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    expect(genRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50)); // let the background IIFE register + spawn
    expect(JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"))[0].status).toBe("running");
    const cancel = await app.request("/api/repo-graph/arch/cancel", { method: "POST", headers: { "X-Siltpoke-Secret": "s" } });
    expect(cancel.status).toBe(200);
    // poll the detached run to its terminal
    const start = Date.now();
    while (JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"))[0].status === "running") {
      if (Date.now() - start > 2000) throw new Error("timed out waiting for cancelled");
      await new Promise((r) => setTimeout(r, 5));
    }
    const tasks = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"));
    expect(tasks[0].status).toBe("cancelled");
    expect(tasks[0].costUsd ?? null).toBeNull(); // SIGKILL'd run: no fabricated cost
  });

  test("/arch/cancel with no active task → 404", async () => {
    const { home } = seedHome();
    const app = mount(home);
    const res = await app.request("/api/repo-graph/arch/cancel", { method: "POST", headers: { "X-Siltpoke-Secret": "s" } });
    expect(res.status).toBe(404);
  });
});
