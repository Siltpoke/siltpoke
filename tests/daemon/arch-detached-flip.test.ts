/**
 * Detached flip. The generate/explain handlers no longer await the
 * full `claude -p` pass: they return `{taskId}` immediately (HTTP 202) and run
 * the LLM pass as a floating background promise. The run survives client
 * disconnect (the old disconnect-auto-cancel listener is REMOVED — now
 * backstopped by the wall-clock guard + reconnect). A paid op still records
 * (finish + cost ledger + model cache) AFTER the request ended → never invisible.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";
import type { UsageEvent } from "../../src/state/usage";

const HASH = "deadbeef0d02";
const tmps: string[] = [];

const VALID_DOC = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, order: 0, members: ["brain", "critic"] }],
  nodes: [
    { id: "brain", kind: "cont", title: { value: "Brain", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, drillTo: "brain" },
    { id: "critic", kind: "cont", title: { value: "Critic", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, drillTo: "critic" },
  ],
  edges: [{ source: "critic", target: "brain", verb: { value: "spawns claude -p", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] } }],
};

function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-detached-"));
  tmps.push(home);
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(home, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  const graph = {
    schemaVersion: 1,
    nodes: [
      { id: "file:src/brain/brain.ts:", type: "file", name: "brain.ts", path: "src/brain/brain.ts", lineRange: [1, 80] },
      { id: "function:src/brain/brain.ts:runBrain", type: "function", name: "runBrain", path: "src/brain/brain.ts", lineRange: [12, 40], signature: "export async function runBrain(): Promise<void>" },
      { id: "file:src/critic/run-critic.ts:", type: "file", name: "run-critic.ts", path: "src/critic/run-critic.ts", lineRange: [1, 80] },
      { id: "function:src/critic/run-critic.ts:runCritic", type: "function", name: "runCritic", path: "src/critic/run-critic.ts", lineRange: [12, 40], signature: "export async function runCritic(): Promise<void>" },
    ],
    edges: [],
  };
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify(graph));
  writeFileSync(join(storageDir, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: projectRoot, proj_hash: HASH,
    last_indexed_ts: "2026-06-08T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 2, function: 2, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
  return home;
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function mount(home: string, provider: BrainProvider) {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s", archBrainProvider: provider });
  return app;
}
function generate(app: Hono, body: Record<string, unknown>) {
  return app.request("/api/repo-graph/arch/generate", {
    method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
    body: JSON.stringify(body),
  });
}
function readTasks(home: string): Array<{ id: string; status: string; costUsd: number | null }> {
  const p = join(home, "tasks.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}
function readEvents(home: string): UsageEvent[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
}
async function pollUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function modelCacheExists(home: string): boolean {
  // writeArchModel persists `<storageDir>/arch-model.json` on a successful run.
  return existsSync(join(home, "repo-memory", HASH, "arch-model.json"));
}

describe("detached: returns {taskId} promptly, records after the request ends", () => {
  test("a slow generate returns {taskId,running} 202 BEFORE the Brain completes, then records done+cost+ledger+cache detached", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gatedProvider: BrainProvider = async () => {
      await gate; // the Brain "runs" until the test releases it
      return { markdown: JSON.stringify(VALID_DOC), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0.4 } };
    };
    const home = seedHome();
    const app = mount(home, gatedProvider);

    const res = await generate(app, { repo: HASH });
    // prompt return — NOT blocked on the Brain
    expect(res.status).toBe(202);
    const body = (await res.json()) as { success: boolean; taskId: string; status: string };
    expect(body.taskId).toBeTruthy();
    expect(body.status).toBe("running");
    // deterministically still running: the provider is gated, so the run cannot
    // have completed by the time the early response arrived.
    expect(readTasks(home)[0]!.status).toBe("running");

    // let the detached run finish — it records AFTER the request already returned
    release();
    await pollUntil(() => readEvents(home).length >= 1);
    const tasks = readTasks(home);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.costUsd).toBeCloseTo(0.4, 5);
    const events = readEvents(home).filter((e) => e.kind === "arch_generate");
    expect(events).toHaveLength(1);
    expect(events[0]!.total_cost_usd).toBeCloseTo(0.4, 5);
    // the model reached the result-cache (reconnect reads it from here)
    expect(modelCacheExists(home)).toBe(true);
  });

  test("client disconnect does NOT cancel the detached run (listener removed) — it still reaches done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const provider: BrainProvider = async ({ signal }) => {
      await gate;
      // if a disconnect listener were still wired, the run would have been aborted
      if (signal?.aborted) throw new Error("aborted");
      return { markdown: JSON.stringify(VALID_DOC), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0.4 } };
    };
    const home = seedHome();
    const app = mount(home, provider);

    const reqCtl = new AbortController();
    const res = await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }), signal: reqCtl.signal,
    });
    expect(res.status).toBe(202);
    reqCtl.abort(); // simulate navigate-away AFTER the early response
    release();
    await pollUntil(() => readTasks(home)[0]?.status !== "running");
    expect(readTasks(home)[0]!.status).toBe("done"); // survived disconnect, NOT cancelled
  });

  test("a 2nd generate while one runs detached still 409s (one-at-a-time lock unchanged)", async () => {
    const gate = new Promise<void>(() => {}); // never resolves → first run stays running
    const home = seedHome();
    const app = mount(home, async () => { await gate; return { markdown: "", usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: null } }; });
    const r1 = await generate(app, { repo: HASH });
    expect(r1.status).toBe(202);
    const r2 = await generate(app, { repo: HASH });
    expect(r2.status).toBe(409);
  });

  test("a throwing Brain records `failed` detached — no unhandledRejection escapes", async () => {
    const home = seedHome();
    const app = mount(home, async () => { throw new Error("claude -p exited 1"); });
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202); // still returns promptly
    await pollUntil(() => readTasks(home)[0]?.status !== "running");
    const tasks = readTasks(home);
    expect(tasks[0]!.status).toBe("failed");
    expect(tasks[0]!.costUsd ?? null).toBeNull();
  });

  test("the timeout guard still bounds a detached run (flip did not bypass it)", async () => {
    const prev = process.env.SILTPOKE_ARCH_TIMEOUT_MS;
    process.env.SILTPOKE_ARCH_TIMEOUT_MS = "30";
    try {
      const home = seedHome();
      // hangs forever unless aborted → only the wall-clock guard can end it
      const app = mount(home, ({ signal }) => new Promise((_res, rej) => { signal?.addEventListener("abort", () => rej(new Error("aborted"))); }));
      const res = await generate(app, { repo: HASH });
      expect(res.status).toBe(202);
      await pollUntil(() => readTasks(home)[0]?.status !== "running");
      const tasks = readTasks(home);
      expect(tasks[0]!.status).toBe("crashed"); // timed out, not done/failed
      expect(tasks[0]!.costUsd ?? null).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.SILTPOKE_ARCH_TIMEOUT_MS;
      else process.env.SILTPOKE_ARCH_TIMEOUT_MS = prev;
    }
  });
});
