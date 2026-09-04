/**
 * The user-facing POST /api/repo-graph/explain
 * handler wrapped in the task registry, mirroring generate: a run is visible the
 * moment it starts, cancellable (SIGTERM→SIGKILL the `claude -p` subprocess),
 * and its cost lands in the usage-events ledger on a REAL Brain call (a cache
 * hit spent $0 → no event). The internal trace/purpose call (POST
 * /trace/purpose) is deliberately NOT wrapped — it must stay fast + unlocked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";
import type { UsageEvent } from "../../src/state/usage";

const HASH = "deadbeef0003";
const tmps: string[] = [];

function seedHome(): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-explainreg-"));
  tmps.push(home);
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(home, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  const graph = {
    schemaVersion: 1,
    nodes: [{ id: "file:src/a/x.ts:", type: "file", name: "x.ts", path: "src/a/x.ts", lineRange: [1, 20] }],
    edges: [],
  };
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify(graph));
  writeFileSync(join(storageDir, "queryIndex.json"), JSON.stringify({
    schemaVersion: 1,
    name_to_node_ids: { "x.ts": ["file:src/a/x.ts:"] },
    path_to_node_ids: { "src/a/x.ts": ["file:src/a/x.ts:"] },
  }));
  writeFileSync(join(storageDir, "fingerprints.json"), JSON.stringify({ schemaVersion: 1, files: {} }));
  writeFileSync(join(storageDir, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: projectRoot, proj_hash: HASH,
    last_indexed_ts: "2026-06-08T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 1, function: 0, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
  return { home };
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Immediate, real-spend Brain (fresh explanation → fromCache:false). */
const okProvider: BrainProvider = async () => ({
  markdown: "# x.ts\n\nDefined in [src/a/x.ts:1-20].\n",
  usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 60, output_tokens: 25, total_cost_usd: 0.05 },
});

/** Blocks until its signal aborts — a slow `claude -p` stand-in for cancel/lock. */
const blockingProvider: BrainProvider = ({ signal, onSpawn }) =>
  new Promise((_res, rej) => {
    onSpawn?.({ pid: 222333, kill: () => {} });
    if (signal?.aborted) return rej(new Error("aborted"));
    signal?.addEventListener("abort", () => rej(new Error("aborted")));
  });

function mount(home: string, provider: BrainProvider) {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s", explainBrainProvider: provider });
  return app;
}

function readEvents(home: string): UsageEvent[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
}

// POST /api/repo-graph/explain is secret-gated (daemon-hardening security
// audit, finding 3 — residual gap); mount() above sets secret: "s".
function explain(app: Hono, body: Record<string, unknown>) {
  return app.request("/api/repo-graph/explain", {
    method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
    body: JSON.stringify(body),
  });
}
function taskStatus(home: string): string | undefined {
  const p = join(home, "tasks.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Array<{ status: string }>)[0]?.status : undefined;
}
/** Detached: the explain run records AFTER the 202 — poll the registry. */
async function pollTerminal(home: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (taskStatus(home) === "running" || taskStatus(home) === undefined) {
    if (Date.now() - start > timeoutMs) throw new Error("pollTerminal timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("explain handler — registry wiring", () => {
  test("register writes a running explain task the moment it starts (visible)", async () => {
    const { home } = seedHome();
    const app = mount(home, blockingProvider);
    const p = explain(app, { repo: HASH, target: "src/a/x.ts" });
    await new Promise((r) => setTimeout(r, 50));
    const tasks = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"));
    expect(tasks[0].status).toBe("running");
    expect(tasks[0].kind).toBe("explain");
    // cancel via the generate cancel endpoint (shared one-at-a-time registry)
    await app.request("/api/repo-graph/arch/cancel", { method: "POST", headers: { "X-Siltpoke-Secret": "s" } });
    await p;
  });

  test("a fresh (real-spend) explain appends an `explain` usage-event with its cost (detached)", async () => {
    const { home } = seedHome();
    const app = mount(home, okProvider);
    const res = await explain(app, { repo: HASH, target: "src/a/x.ts" });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    const events = readEvents(home);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("explain");
    expect(events[0].total_cost_usd).toBeCloseTo(0.05, 5);
    expect(taskStatus(home)).toBe("done");
  });

  test("a cache-hit explain records NO new usage-event ($0 this run) (detached)", async () => {
    const { home } = seedHome();
    const app = mount(home, okProvider);
    await explain(app, { repo: HASH, target: "src/a/x.ts" });   // fresh → 1 event
    await pollTerminal(home);                                     // complete + cache
    expect(readEvents(home)).toHaveLength(1);
    const res2 = await explain(app, { repo: HASH, target: "src/a/x.ts" }); // cache → 0 new
    expect(res2.status).toBe(202);
    await pollTerminal(home);
    expect(readEvents(home)).toHaveLength(1);
  });

  test("cancel → registry cancelled (detached: explain already returned 202; cancel kills the background run)", async () => {
    const { home } = seedHome();
    const app = mount(home, blockingProvider);
    const res = await explain(app, { repo: HASH, target: "src/a/x.ts" });
    expect(res.status).toBe(202);
    // detached run is still running (blockingProvider never resolves) — let the
    // background IIFE start + onSpawn fire, then cancel it manually.
    await new Promise((r) => setTimeout(r, 30));
    expect(taskStatus(home)).toBe("running");
    const cancel = await app.request("/api/repo-graph/arch/cancel", { method: "POST", headers: { "X-Siltpoke-Secret": "s" } });
    expect(cancel.status).toBe(200);
    await pollTerminal(home);
    const tasks = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"));
    expect(tasks[0].status).toBe("cancelled");
    expect(tasks[0].costUsd ?? null).toBeNull();
  });
});
