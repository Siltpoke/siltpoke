/**
 * Daemon-restart honesty, at the WIRING level. The registry CLASS
 * reconcile (running + dead pid → crashed) is unit-tested in task-registry.test
 * with an injected `isAlive`. This proves the live path: mounting the repo-graph
 * routes constructs ONE TaskRegistry on `home` (server.ts mounts once per daemon
 * start), whose constructor runs `load()` with the REAL `process.kill(pid,0)`
 * ESRCH probe — so a stale `running` record from a crashed prior daemon flips to
 * `crashed` the moment the routes mount. Never falsely running, never a stuck
 * lock, never silently dropped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";

const tmps: string[] = [];
// A pid that is reliably NOT a live process (process.kill(DEAD_PID, 0) → ESRCH).
const DEAD_PID = 999999;

afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function seedStaleTasksJson(): string {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-restart-"));
  tmps.push(home);
  // Simulate a crashed prior daemon: a `running` record whose pid is gone.
  writeFileSync(join(home, "tasks.json"), JSON.stringify([
    { id: "t-stale", kind: "arch_generate", repo: "r", status: "running", startedTs: "2026-06-08T00:00:00Z", pid: DEAD_PID },
  ]));
  return home;
}

describe("daemon restart reconciles a stale running task to crashed (live wiring)", () => {
  test("mounting routes with a stale running tasks.json flips it to crashed via the real pid probe", () => {
    const home = seedStaleTasksJson();
    // Mount = daemon start. The TaskRegistry constructor's load() runs the real
    // ESRCH probe (no injected isAlive) against DEAD_PID → crashed.
    mountRepoGraphRoutes(new Hono(), { cwd: home, home, secret: "s" });
    const tasks = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"));
    expect(tasks[0].status).toBe("crashed");
    expect(tasks[0].endedTs).toBeTruthy(); // never silently dropped — it has a terminal stamp
  });

  test("a fresh generate is accepted after restart (no stuck lock from the dead task)", async () => {
    const home = seedStaleTasksJson();
    const app = new Hono();
    // A provider that blocks so we can observe the lock was acquirable (register
    // succeeded → not 409). Resolve via cancel to end clean.
    mountRepoGraphRoutes(app, {
      cwd: home, home, secret: "s",
      archBrainProvider: ({ signal }) => new Promise((_res, rej) => {
        signal?.addEventListener("abort", () => rej(new Error("aborted")));
      }),
    });
    // No repo indexed → resolveActiveRepo returns null → 404, NOT 409. A 409
    // would mean the dead task still held the lock. 404 proves the lock is free.
    const res = await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: "nonexistent" }),
    });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(409);
  });
});
