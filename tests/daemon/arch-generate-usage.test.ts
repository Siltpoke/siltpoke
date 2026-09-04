/**
 * A completed generate appends its cost to usage-events.jsonl (kind
 * "arch_generate"), so a paid run is visible to cost views. Honest
 * boundary pinned here: a CACHE hit spent $0 this invocation → it records NO
 * new usage-event (recording a cache read as fresh spend = a fabricated number,
 * the honest-metrics linchpin). A killed run is covered by arch-generate-cancel
 * (costUsd null, no event).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";
import { PreSpawnError } from "../../src/explain/providers";
import type { UsageEvent } from "../../src/state/usage";

const HASH = "deadbeef0002";
const tmps: string[] = [];

// A graph rich enough that VALID_DOC's evidence (brain + critic) is coherent.
const VALID_DOC = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, order: 0, members: ["brain", "critic"] }],
  nodes: [
    { id: "brain", kind: "cont", title: { value: "Brain", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, drillTo: "brain" },
    { id: "critic", kind: "cont", title: { value: "Critic", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, drillTo: "critic" },
  ],
  edges: [{ source: "critic", target: "brain", verb: { value: "spawns claude -p", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] } }],
};

function seedHome(): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-genusage-"));
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
  return { home };
}
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A Brain provider that immediately returns a valid arch doc + real usage. */
const okProvider: BrainProvider = async () => ({
  markdown: JSON.stringify(VALID_DOC),
  usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0.4 },
});

/** A Brain provider that spends money but returns un-parseable output → the
 * generate outcome is `malformed` (rejected result, but the Brain WAS billed). */
const malformedProvider: BrainProvider = async () => ({
  markdown: "not json at all",
  usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 80, output_tokens: 30, total_cost_usd: 0.1 },
});

function mount(home: string, provider: BrainProvider = okProvider) {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s", archBrainProvider: provider });
  return app;
}

function readEvents(home: string): UsageEvent[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
}

async function generate(app: Hono, body: Record<string, unknown>) {
  return app.request("/api/repo-graph/arch/generate", {
    method: "POST", headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
    body: JSON.stringify(body),
  });
}
function taskStatus(home: string): string | undefined {
  const p = join(home, "tasks.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Array<{ status: string }>)[0]?.status : undefined;
}
/** Detached: the run records AFTER the 202 response — poll the registry. */
async function pollTerminal(home: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (taskStatus(home) === "running" || taskStatus(home) === undefined) {
    if (Date.now() - start > timeoutMs) throw new Error("pollTerminal timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** The ledger append is awaited AFTER the registry terminal write (tasks.json
 * flips synchronously via atomicWrite) — reading events the instant the task
 * is terminal races the appendFile. Poll for the expected line count instead;
 * returns early on success, settles at timeout for == assertions. */
async function pollEvents(home: string, n: number, timeoutMs = 2000): Promise<UsageEvent[]> {
  const start = Date.now();
  let events = readEvents(home);
  while (events.length < n && Date.now() - start <= timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
    events = readEvents(home);
  }
  return events;
}

// Detached: /arch/generate returns {taskId} 202; the cost ledger is written
// by the background run, so these poll the terminal then assert the ledger —
// the cost SEMANTICS (fresh records, cache=$0 doesn't, malformed-but-billed does)
// are settled and unchanged by the flip; only the delivery (detached) changed.
describe("generate handler — cost → usage-events (detached)", () => {
  test("a fresh (real-spend) generate appends an arch_generate usage-event with its cost", async () => {
    const { home } = seedHome();
    const app = mount(home);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("arch_generate");
    expect(events[0].total_cost_usd).toBeCloseTo(0.4, 5);
    expect(events[0].input_tokens).toBe(100);
    expect(events[0].output_tokens).toBe(50);
    expect(taskStatus(home)).toBe("done");
  });

  test("a cache-hit generate records NO new usage-event (it spent $0 this run)", async () => {
    const { home } = seedHome();
    const app = mount(home);
    await generate(app, { repo: HASH });            // fresh → 1 event
    await pollTerminal(home);                        // let it complete + cache
    // `pollEvents`, not a bare `readEvents` — the three reads in this test were
    // the only ones in the file still doing it the racy way, and this line is
    // where it bit: measured 1 failure in 5 isolated runs, reporting 0 events
    // where 1 was expected. The helper's own comment says why (the ledger
    // append is awaited AFTER the registry flips terminal, so a read the
    // instant `pollTerminal` returns races the `appendFile`).
    expect(await pollEvents(home, 1)).toHaveLength(1);
    const res2 = await generate(app, { repo: HASH }); // fromCache → 0 new events
    expect(res2.status).toBe(202);
    await pollTerminal(home);
    // Waits for a SECOND event that must never arrive, then settles at the
    // timeout — the "settles at timeout for == assertions" half of the
    // helper's contract. A bare read here would pass on a cache hit that
    // wrongly billed, simply by looking before the append landed.
    expect(await pollEvents(home, 2, 250)).toHaveLength(1); // still 1 — cache hit spent $0
  });

  test("a billed-but-rejected (malformed) generate STILL records its cost (no invisible burn)", async () => {
    // The Brain ran + was billed; the output was un-parseable. The money spent
    // must still hit the ledger (the SAME invisible-burn class this track exists
    // to kill). NOT a fabricated number — the real usage the rejected call
    // reported. Detached: no 422 response anymore — the record IS the assertion.
    const { home } = seedHome();
    const app = mount(home, malformedProvider);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("arch_generate");
    expect(events[0].total_cost_usd).toBeCloseTo(0.1, 5);
    expect(events[0].input_tokens).toBe(80);
    // Registry: the run's lifecycle completed (subprocess ran + was billed) →
    // `done`; result-quality (malformed) is separate from lifecycle status. The
    // record carries the REAL cost, not null (the decision: log anything that costs money).
    const tasks = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8"));
    expect(tasks[0].status).toBe("done");
    expect(tasks[0].costUsd).toBeCloseTo(0.1, 5);
  });
});

// A run that REACHED the paid subprocess and exited non-zero must still hit
// the ledger (unmetered generate calls previously went unledgered). Real usage recovered
// from the stdout tail when parseable (`basis: "tail_parsed"`), else the
// pre-flight estimate (`basis: "estimated"`). pre_check_failed spends
// nothing and stays unledgered (untouched).
// A sample run shape embedded in the providers.ts-style thrown message (shared by
// the failed-run suite and the timeout-kill suite).
const TAIL_MSG =
  'claude -p exited 1: stdout tail: ,"total_cost_usd":0.8542,"usage":' +
  '{"input_tokens":150000,"cache_creation_input_tokens":48211,' +
  '"cache_read_input_tokens":1024,"output_tokens":31}}]';

describe("generate handler — failed-run ledger (detached)", () => {
  const tailFailProvider: BrainProvider = async () => {
    throw new Error(TAIL_MSG);
  };
  /** Failure whose message carries NO usage JSON (e.g. SIGKILL, empty tails). */
  const blindFailProvider: BrainProvider = async () => {
    throw new Error("claude -p exited 137");
  };

  test("test_failed_run_with_parseable_tail_ledgers_real_usage (basis tail_parsed)", async () => {
    const { home } = seedHome();
    const app = mount(home, tailFailProvider);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    expect(taskStatus(home)).toBe("failed");
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("arch_generate");
    expect(events[0].basis).toBe("tail_parsed");
    expect(events[0].total_cost_usd).toBeCloseTo(0.8542, 5);
    expect(events[0].input_tokens).toBe(150000);
    expect(events[0].cache_creation_input_tokens).toBe(48211);
    expect(events[0].output_tokens).toBe(31);
  });

  test("test_failed_run_with_unparseable_tail_ledgers_estimate (basis estimated)", async () => {
    // Contingency (signed story): truncated/unparseable tail → ledger the
    // pre-flight estimate flagged pure-estimate; never throw from the write.
    const { home } = seedHome();
    const app = mount(home, blindFailProvider);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    expect(taskStatus(home)).toBe("failed");
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("arch_generate");
    expect(events[0].basis).toBe("estimated");
    // estimateArchGenerate over the seeded graph: tokens + estUsd are model
    // outputs, not constants — pin the honesty invariants, not the figures.
    expect(events[0].input_tokens).toBeGreaterThan(0);
    expect(events[0].total_cost_usd ?? 0).toBeGreaterThan(0);
  });

  // ── review BF1 — a pre-spawn failure (claude binary missing / stdin write
  // failure) NEVER reached the paid subprocess: $0 spent. Today's catch block
  // ledgers an "estimated" entry anyway (~$1.5 phantom per retry) because the
  // ENOENT-shaped message has no parseable tail → estimate fallback fires.
  test("test_BF1_pre_spawn_failure_ledgers_NOTHING (binary missing → 0 usage events)", async () => {
    const preSpawnProvider: BrainProvider = async () => {
      // The structural marker providers.ts throws when Bun.spawn itself fails
      // (real shape: `Executable not found in $PATH: "claude"` / ENOENT).
      throw new PreSpawnError('claude -p never started: Executable not found in $PATH: "claude"');
    };
    const { home } = seedHome();
    const app = mount(home, preSpawnProvider);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    expect(taskStatus(home)).toBe("failed"); // the failure itself is still recorded
    // Absence assertion: the (buggy) ledger write lands AFTER the terminal —
    // poll FOR an event and require it never to arrive within the window.
    const events = await pollEvents(home, 1, 250);
    expect(events).toHaveLength(0); // $0 spent → no usage event, not even estimated
  });

  test("test_successful_run_keeps_legacy_shape (no basis field)", async () => {
    // Additive-only contract: the success path's event is byte-compatible with
    // prior lines (absent basis = legacy real) — old readers unaffected.
    const { home } = seedHome();
    const app = mount(home);
    await generate(app, { repo: HASH });
    await pollTerminal(home);
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect("basis" in events[0]).toBe(false);
  });
});

// ── review BF2 — the aborted-signal early-return treated ALL kills the same.
// A run SIGKILL'd at the wall-clock ceiling (timeoutKill → `crashed`) burned
// real money the whole time — the exact unledgered-runaway class this task
// exists for — and must ledger. A user-cancel (`cancelled`) is ambiguous
// spend and stays unledgered (declared residual). Distinguishable because
// killLive() writes the terminal status SYNCHRONOUSLY inside abort()'s frame,
// before the floating catch's microtask reads it.
describe("generate handler — BF2 timeout-kill ledgers, user-cancel does not", () => {
  const ORIG_TIMEOUT = process.env.SILTPOKE_ARCH_TIMEOUT_MS;
  afterEach(() => {
    if (ORIG_TIMEOUT === undefined) delete process.env.SILTPOKE_ARCH_TIMEOUT_MS;
    else process.env.SILTPOKE_ARCH_TIMEOUT_MS = ORIG_TIMEOUT;
  });

  /** Hangs until aborted, then rejects the way a SIGKILL'd claude -p does
   * (exit 137, nothing parseable in the tails). */
  const hangUntilAbortProvider: BrainProvider = ({ signal }) =>
    new Promise((_resolve, reject) => {
      const die = () => reject(new Error("claude -p exited 137"));
      if (signal?.aborted) return die();
      signal?.addEventListener("abort", die);
    });

  test("test_BF2_timeout_killed_run_LEDGERS (crashed → basis estimated)", async () => {
    process.env.SILTPOKE_ARCH_TIMEOUT_MS = "40"; // ceiling fires almost immediately
    const { home } = seedHome();
    const app = mount(home, hangUntilAbortProvider);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202);
    await pollTerminal(home);
    expect(taskStatus(home)).toBe("crashed"); // machine timeout, NOT user cancel
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("arch_generate");
    expect(events[0].basis).toBe("estimated"); // SIGKILL left no parseable tail
    expect(events[0].input_tokens).toBeGreaterThan(0);
    expect(events[0].total_cost_usd ?? 0).toBeGreaterThan(0);
  });

  test("test_BF2_timeout_killed_run_with_parseable_tail_prefers_real_figures (basis tail_parsed)", async () => {
    // SIGTERM-first escalation CAN leave a flushed result tail — when it does,
    // the crashed-run ledger must carry the REAL figures, not the estimate.
    process.env.SILTPOKE_ARCH_TIMEOUT_MS = "40";
    const tailOnAbortProvider: BrainProvider = ({ signal }) =>
      new Promise((_resolve, reject) => {
        const die = () => reject(new Error(TAIL_MSG));
        if (signal?.aborted) return die();
        signal?.addEventListener("abort", die);
      });
    const { home } = seedHome();
    const app = mount(home, tailOnAbortProvider);
    await generate(app, { repo: HASH });
    await pollTerminal(home);
    expect(taskStatus(home)).toBe("crashed");
    const events = await pollEvents(home, 1);
    expect(events).toHaveLength(1);
    expect(events[0].basis).toBe("tail_parsed");
    expect(events[0].total_cost_usd).toBeCloseTo(0.8542, 5);
    expect(events[0].input_tokens).toBe(150000);
  });

  test("test_BF2_user_cancelled_run_does_NOT_ledger (ambiguous spend stays unledgered)", async () => {
    delete process.env.SILTPOKE_ARCH_TIMEOUT_MS; // default 15-min ceiling never fires here
    const { home } = seedHome();
    const app = mount(home, hangUntilAbortProvider);
    const res = await generate(app, { repo: HASH });
    expect(res.status).toBe(202); // register ran synchronously before the 202
    const cancel = await app.request("/api/repo-graph/arch/cancel", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": "s" },
    });
    expect(cancel.status).toBe(200);
    await pollTerminal(home);
    expect(taskStatus(home)).toBe("cancelled");
    const events = await pollEvents(home, 1, 250);
    expect(events).toHaveLength(0);
  });
});
