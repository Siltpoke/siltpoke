/**
 * Reconnect server endpoints. The run is detached; the client observes it
 * + fetches the cached result. Three endpoints:
 *  - GET /arch/task → registry.latest() (NOT current(), which is null the
 *    instant a run ends) so a client returning to the page sees the last run.
 *  - GET /arch/model → the cached generated model as JSON (in-place render on
 *    reconnect, no page reload).
 *  - GET /explain/result → the cached explanation built into an Explanation
 *    (reuses buildExplanation).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";

const HASH = "deadbeef0e03";
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
  const home = mkdtempSync(join(tmpdir(), "siltpoke-reconnect-"));
  tmps.push(home);
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(home, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "file:src/brain/brain.ts:", type: "file", name: "brain.ts", path: "src/brain/brain.ts", lineRange: [1, 80] },
      { id: "function:src/brain/brain.ts:runBrain", type: "function", name: "runBrain", path: "src/brain/brain.ts", lineRange: [12, 40], signature: "export async function runBrain(): Promise<void>" },
      { id: "file:src/critic/run-critic.ts:", type: "file", name: "run-critic.ts", path: "src/critic/run-critic.ts", lineRange: [1, 80] },
      { id: "function:src/critic/run-critic.ts:runCritic", type: "function", name: "runCritic", path: "src/critic/run-critic.ts", lineRange: [12, 40], signature: "export async function runCritic(): Promise<void>" },
    ],
    edges: [],
  }));
  writeFileSync(join(storageDir, "queryIndex.json"), JSON.stringify({
    schemaVersion: 1,
    name_to_node_ids: { "brain.ts": ["file:src/brain/brain.ts:"], runBrain: ["function:src/brain/brain.ts:runBrain"] },
    path_to_node_ids: { "src/brain/brain.ts": ["file:src/brain/brain.ts:", "function:src/brain/brain.ts:runBrain"] },
  }));
  writeFileSync(join(storageDir, "fingerprints.json"), JSON.stringify({ schemaVersion: 1, files: {} }));
  writeFileSync(join(storageDir, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: projectRoot, proj_hash: HASH,
    last_indexed_ts: "2026-06-08T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 2, function: 2, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
  return home;
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const archOk: BrainProvider = async () => ({
  markdown: JSON.stringify(VALID_DOC),
  usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0.4 },
});
const explainOk: BrainProvider = async () => ({
  markdown: "# brain.ts\n\nrunBrain is the entry point. See [src/brain/brain.ts:12] for details.\n",
  usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 60, output_tokens: 25, total_cost_usd: 0.05 },
});

function mount(home: string, opts: { arch?: BrainProvider; explain?: BrainProvider } = {}) {
  const app = new Hono();
  mountRepoGraphRoutes(app, {
    cwd: home, home, secret: "s",
    archBrainProvider: opts.arch,
    explainBrainProvider: opts.explain,
    explainSourceProvider: async () => "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nfunction runBrain() {}\n",
  });
  return app;
}
function taskStatus(home: string): string | undefined {
  const p = join(home, "tasks.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Array<{ status: string }>)[0]?.status : undefined;
}
async function pollTerminal(home: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (taskStatus(home) === "running" || taskStatus(home) === undefined) {
    if (Date.now() - start > timeoutMs) throw new Error("pollTerminal timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function getJson(app: Hono, path: string) {
  return app.request(path);
}

describe("GET /arch/task returns latest() (survives run-end), not current()", () => {
  test("after a run ends, /arch/task still returns the terminal record (current() would be null)", async () => {
    const home = seedHome();
    const app = mount(home, { arch: archOk });
    await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    await pollTerminal(home);
    const res = await getJson(app, "/api/repo-graph/arch/task");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { task: { status: string; kind: string; costUsd: number | null } | null } };
    expect(body.data.task).not.toBeNull(); // latest() — survives the run ending
    expect(body.data.task!.status).toBe("done");
    expect(body.data.task!.kind).toBe("arch_generate");
    expect(body.data.task!.costUsd).toBeCloseTo(0.4, 5);
  });

  test("no task ever run → task is null", async () => {
    const home = seedHome();
    const app = mount(home);
    const res = await getJson(app, "/api/repo-graph/arch/task");
    const body = (await res.json()) as { data: { task: unknown } };
    expect(body.data.task).toBeNull();
  });
});

describe("GET /arch/model returns the cached generated model as JSON", () => {
  test("after a detached generate completes, /arch/model serves the cached model", async () => {
    const home = seedHome();
    const app = mount(home, { arch: archOk });
    await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    await pollTerminal(home);
    const res = await getJson(app, `/api/repo-graph/arch/model?repo=${HASH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { model: { boundary: string }; groundedPct: number } };
    expect(body.data.model.boundary).toBe("demo");
    expect(typeof body.data.groundedPct).toBe("number");
  });

  test("no cached model (never generated) → 404", async () => {
    const home = seedHome();
    const app = mount(home);
    const res = await getJson(app, `/api/repo-graph/arch/model?repo=${HASH}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /explain/result builds the cached explanation (reuses buildExplanation)", () => {
  test("after a detached explain completes, /explain/result serves the Explanation", async () => {
    const home = seedHome();
    const app = mount(home, { explain: explainOk });
    // Secret-gated (daemon-hardening security audit, finding 3 — residual
    // gap); mount() sets secret: "s".
    await app.request("/api/repo-graph/explain", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH, target: "src/brain/brain.ts" }),
    });
    await pollTerminal(home);
    const res = await getJson(app, `/api/repo-graph/explain/result?repo=${HASH}&target=${encodeURIComponent("src/brain/brain.ts")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string; lead: string; citations: Array<{ ref: string }> } };
    expect(body.data.title).toBe("brain.ts");
    expect(body.data.lead).toContain("runBrain");
  });

  test("no cached explanation → 404", async () => {
    const home = seedHome();
    const app = mount(home);
    const res = await getJson(app, `/api/repo-graph/explain/result?repo=${HASH}&target=${encodeURIComponent("src/brain/brain.ts")}`);
    expect(res.status).toBe(404);
  });
});

// ── Cross-repo spinner bleed ─────────────────────────────────────────────
// The registry is one-task-at-a-time ACROSS repos, so latest() is global; the
// route must let a client ask "the latest task FOR THIS REPO" or every repo's
// page attaches to whatever repo happens to be generating.
describe("cross-repo bleed — GET /arch/task ?repo= filter + 409 repo identity", () => {
  async function runOneGenerate(home: string, app: Hono): Promise<void> {
    await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    await pollTerminal(home);
  }

  test("?repo= matching the task's repo → task returned, repo field present", async () => {
    const home = seedHome();
    const app = mount(home, { arch: archOk });
    await runOneGenerate(home, app);
    const res = await getJson(app, `/api/repo-graph/arch/task?repo=${HASH}`);
    const body = (await res.json()) as { data: { task: { repo: string; status: string } | null } };
    expect(body.data.task).not.toBeNull();
    expect(body.data.task!.repo).toBe(HASH);
    expect(body.data.task!.status).toBe("done");
  });

  test("?repo= NOT matching the task's repo → task is null (no bleed)", async () => {
    const home = seedHome();
    const app = mount(home, { arch: archOk });
    await runOneGenerate(home, app);
    const res = await getJson(app, "/api/repo-graph/arch/task?repo=0th3rrep0aaa");
    const body = (await res.json()) as { data: { task: unknown } };
    expect(body.data.task).toBeNull();
  });

  test("no ?repo= param → global latest (back-compat)", async () => {
    const home = seedHome();
    const app = mount(home, { arch: archOk });
    await runOneGenerate(home, app);
    const res = await getJson(app, "/api/repo-graph/arch/task");
    const body = (await res.json()) as { data: { task: unknown } };
    expect(body.data.task).not.toBeNull();
  });

  test("409 while a run is in flight carries the active task's repo", async () => {
    const home = seedHome();
    // The Brain call sits behind async input loading in the floating run — the
    // provider may not have been invoked yet when the 409 lands, so `release`
    // is awaited into existence before the final unblock.
    let release: (() => void) | undefined;
    const held: BrainProvider = () =>
      new Promise((res) => {
        release = () =>
          res({
            markdown: JSON.stringify(VALID_DOC),
            usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0.4 },
          });
      });
    const app = mount(home, { arch: held });
    const first = await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    expect(first.status).toBe(202);
    const second = await app.request("/api/repo-graph/arch/generate", {
      method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
      body: JSON.stringify({ repo: HASH }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { activeTaskId?: string; activeTaskRepo?: string | null };
    expect(body.activeTaskId).toBeDefined();
    expect(body.activeTaskRepo).toBe(HASH); // ← client needs this to decide attach vs dismiss
    const start = Date.now();
    while (!release) {
      if (Date.now() - start > 2000) throw new Error("brain provider never reached");
      await new Promise((r) => setTimeout(r, 5));
    }
    release();
    await pollTerminal(home);
  });
});
