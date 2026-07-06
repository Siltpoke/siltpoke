/**
 * Wall-clock timeout guard (linchpin).
 *
 * `claude -p` has NO spawn timeout; the cost hard-cap fires only AFTER it
 * returns → a hung subprocess never trips it. The old approach leaned on
 * disconnect-auto-cancel as the runaway fallback; that listener was removed, so
 * this wall-clock kill becomes the ONLY bound on an abandoned run. A timed-out
 * run is SIGKILL'd (real pid ESRCH) and recorded `crashed` / cost null —
 * machine-timeout ≠ user-cancel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";
import {
  ARCH_TIMEOUT_DEFAULT_MS,
  resolveArchTimeoutMs,
  TaskRegistry,
  type KillableProc,
} from "../../src/daemon/task-registry";

const tmps: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "siltpoke-timeout-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeProc(pid: number, killed: { sig?: string }): KillableProc {
  return { pid, kill: (sig) => { killed.sig = String(sig); } };
}
let n = 0;
const seqIds = () => `t${++n}`;
function isAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("timeoutKill: SIGKILL + crashed + cost null (linchpin)", () => {
  test("a run outliving the ceiling is force-killed (real pid ESRCH) + recorded crashed/cost-null", async () => {
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 50 });
    // a SIGTERM-trapping child → forces the SIGKILL escalation, proving an actual kill
    // (not just controller.abort()). Same oracle as above (kill(pid,0) → ESRCH).
    const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = proc.pid;
    expect(isAliveReal(pid)).toBe(true);
    const rec = r.register("arch_generate", "a", { controller: new AbortController(), proc }, { timeoutMs: 30 })!;
    await proc.exited; // timer fires at 30ms → SIGTERM (no-op, trapped) → 50ms → SIGKILL
    expect(isAliveReal(pid)).toBe(false); // actually dead, not "we called kill"
    expect(r.get(rec.id)!.status).toBe("crashed"); // NOT cancelled, NOT failed
    expect(r.get(rec.id)!.costUsd).toBeNull(); // explicit null, never fabricated
    expect(r.isBusy()).toBe(false); // lock released
  });

  test("a subprocess that spawns AFTER the timeout already fired is still killed (no escape hatch)", async () => {
    // The wall-clock window can elapse during context assembly, BEFORE the Brain
    // call's Bun.spawn → timeoutKill fires with no proc attached yet. The late
    // subprocess must NOT escape: attachProc's spawn-after-cancel guard kills it.
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 50 });
    const rec = r.register("arch_generate", "a", { controller: new AbortController() }, { timeoutMs: 10 })!;
    await new Promise((res) => setTimeout(res, 30)); // let the 10ms ceiling fire
    expect(r.get(rec.id)!.status).toBe("crashed"); // timed out with no proc
    // the subprocess spawns late (context assembly finished after the timeout)
    const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    r.attachProc(rec.id, proc); // must SIGTERM→SIGKILL the orphan-to-be
    await proc.exited;
    expect(isAliveReal(pid)).toBe(false); // killed despite spawning after timeout
  });

  test("timeoutKill aborts the controller (SIGTERM via Bun.spawn signal) like cancel", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const lh = { controller: new AbortController(), proc: fakeProc(222, {}) };
    const rec = r.register("arch_generate", "a", lh)!;
    expect(lh.controller.signal.aborted).toBe(false);
    r.timeoutKill(rec.id);
    expect(lh.controller.signal.aborted).toBe(true);
    expect(r.get(rec.id)!.status).toBe("crashed");
  });

  test("timeoutKill escalates to SIGKILL only when the pid is STILL ALIVE", async () => {
    const killed: { sig?: string } = {};
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 5, isAlive: () => true });
    const rec = r.register("arch_generate", "a", { controller: new AbortController(), proc: fakeProc(333, killed) })!;
    r.timeoutKill(rec.id);
    await new Promise((res) => setTimeout(res, 20));
    expect(killed.sig).toBe("SIGKILL");
  });
});

describe("ceiling wide enough: real work is NOT killed (positive control)", () => {
  test("under-ceiling finish clears the timer → done + cost recorded + no stale crashed", async () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    // arm a short 30ms ceiling, then finish IMMEDIATELY (genuine work completed)
    const rec = r.register("arch_generate", "a", { controller: new AbortController(), proc: fakeProc(1, {}) }, { timeoutMs: 30 })!;
    r.finish(rec.id, { costUsd: 0.42 });
    expect(r.get(rec.id)!.status).toBe("done");
    expect(r.get(rec.id)!.costUsd).toBe(0.42);
    // wait PAST the ceiling — the cleared timer must NOT flip done → crashed
    await new Promise((res) => setTimeout(res, 60));
    expect(r.get(rec.id)!.status).toBe("done"); // timer cleared on finish → no stale fire
    expect(r.isBusy()).toBe(false);
  });

  test("cancel before the ceiling also clears the timer (no stale crashed-over-cancelled)", async () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("arch_generate", "a", { controller: new AbortController(), proc: fakeProc(2, {}) }, { timeoutMs: 30 })!;
    r.cancel(rec.id);
    expect(r.get(rec.id)!.status).toBe("cancelled");
    await new Promise((res) => setTimeout(res, 60));
    expect(r.get(rec.id)!.status).toBe("cancelled"); // not overwritten to crashed
  });
});

describe("timeoutKill on an already-terminal id is a no-op", () => {
  test("calling timeoutKill after finish does not flip done → crashed or double-complete", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("explain", "a", { controller: new AbortController(), proc: fakeProc(3, {}) })!;
    r.finish(rec.id, { costUsd: 0.1 });
    r.timeoutKill(rec.id); // stale fire on a completed task
    expect(r.get(rec.id)!.status).toBe("done");
    expect(r.get(rec.id)!.costUsd).toBe(0.1);
  });
});

describe("SILTPOKE_ARCH_TIMEOUT_MS resolution (handler-layer config)", () => {
  test("default is 15 min (900_000 ms) when unset", () => {
    expect(ARCH_TIMEOUT_DEFAULT_MS).toBe(900_000);
    expect(resolveArchTimeoutMs({})).toBe(900_000);
  });
  test("a valid positive override is honored (giant-repo escape hatch)", () => {
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "1800000" })).toBe(1_800_000);
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "1000" })).toBe(1000);
  });
  test("invalid / non-positive override falls back to the default (no foot-gun)", () => {
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "abc" })).toBe(900_000);
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "0" })).toBe(900_000);
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "-5" })).toBe(900_000);
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "30abc" })).toBe(900_000); // trailing junk → NaN, not 30
  });

  test("scientific-notation / float ms parse correctly (Number, not parseInt truncation)", () => {
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "1.5e6" })).toBe(1_500_000); // parseInt would give 1ms
    expect(resolveArchTimeoutMs({ SILTPOKE_ARCH_TIMEOUT_MS: "900000.5" })).toBe(900_000.5);
  });
});

// ── Handler wiring: the generate route arms the guard from the env ──────────────
const HASH = "deadbeef0c01";
function seedHome(): string {
  const h = home();
  const projectRoot = join(h, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(h, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "file:src/brain/brain.ts:", type: "file", name: "brain.ts", path: "src/brain/brain.ts", lineRange: [1, 80] },
      { id: "function:src/brain/brain.ts:runBrain", type: "function", name: "runBrain", path: "src/brain/brain.ts", lineRange: [12, 40], signature: "export async function runBrain(): Promise<void>" },
    ],
    edges: [],
  }));
  writeFileSync(join(storageDir, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: projectRoot, proj_hash: HASH,
    last_indexed_ts: "2026-06-08T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 1, function: 1, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
  return h;
}

/** A Brain provider that hangs until aborted (the 57-min-wedge simulation). */
const hangingProvider: BrainProvider = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("generate route arms the guard from SILTPOKE_ARCH_TIMEOUT_MS", () => {
  test("a hung generate past the env ceiling is recorded crashed / cost-null (not done, not a fabricated cost)", async () => {
    const prev = process.env.SILTPOKE_ARCH_TIMEOUT_MS;
    process.env.SILTPOKE_ARCH_TIMEOUT_MS = "30"; // 30ms ceiling for a deterministic test
    try {
      const h = seedHome();
      const app = new Hono();
      mountRepoGraphRoutes(app, { cwd: h, home: h, secret: "s", archBrainProvider: hangingProvider });
      const res = await app.request("/api/repo-graph/arch/generate", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
        body: JSON.stringify({ repo: HASH }),
      });
      // Detached: returns {taskId} 202 promptly; the guard fires on the
      // background run → the RECORD (tasks.json) is the linchpin, polled after.
      expect(res.status).toBe(202);
      const readStatus = () => (JSON.parse(readFileSync(join(h, "tasks.json"), "utf8")) as Array<{ status: string }>)[0]?.status;
      const start = Date.now();
      while (readStatus() === "running") {
        if (Date.now() - start > 2000) throw new Error("timed out waiting for crashed");
        await new Promise((r) => setTimeout(r, 5));
      }
      const tasks = JSON.parse(readFileSync(join(h, "tasks.json"), "utf8")) as Array<{ status: string; costUsd: number | null }>;
      expect(tasks[0].status).toBe("crashed"); // machine-timeout, NOT done / cancelled / failed
      expect(tasks[0].costUsd ?? null).toBeNull(); // never fabricated
    } finally {
      if (prev === undefined) delete process.env.SILTPOKE_ARCH_TIMEOUT_MS;
      else process.env.SILTPOKE_ARCH_TIMEOUT_MS = prev;
    }
  });
});
