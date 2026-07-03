/**
 * TaskRegistry: one-task lock, two-phase records, cancel→abort+SIGKILL
 * escalation, persistence, daemon-restart crash recovery.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyResultFile,
  TaskRegistry,
  type KillableProc,
  type TaskRecord,
} from "../../src/daemon/task-registry";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";

const tmps: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "siltpoke-taskreg-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeProc(pid: number, killed: { sig?: string }): KillableProc {
  return { pid, kill: (sig) => { killed.sig = String(sig); } };
}
function liveHandle(proc?: KillableProc) {
  return { controller: new AbortController(), proc };
}

let n = 0;
const seqIds = () => `t${++n}`;

describe("TaskRegistry — lock + two-phase", () => {
  test("register writes a running+started record immediately (invisible-burn fix)", () => {
    const h = home();
    const r = new TaskRegistry(h, { now: () => "2026-06-08T00:00:00Z", idGen: seqIds });
    const rec = r.register("arch_generate", "webapp", liveHandle(fakeProc(111, {})));
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("running");
    expect(rec!.startedTs).toBe("2026-06-08T00:00:00Z");
    expect(rec!.pid).toBe(111);
    // persisted to tasks.json the moment it starts (not only on completion)
    const onDisk = JSON.parse(readFileSync(join(h, "tasks.json"), "utf8")) as TaskRecord[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.status).toBe("running");
  });

  test("one-at-a-time lock: a 2nd register while running returns null", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    expect(r.register("arch_generate", "a", liveHandle())).not.toBeNull();
    expect(r.isBusy()).toBe(true);
    expect(r.register("explain", "b", liveHandle())).toBeNull(); // rejected
  });

  test("finish releases the lock + records done + cost; a new task can start", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("explain", "a", liveHandle())!;
    r.finish(rec.id, { costUsd: 0.42 });
    expect(r.get(rec.id)!.status).toBe("done");
    expect(r.get(rec.id)!.costUsd).toBe(0.42);
    expect(r.isBusy()).toBe(false);
    expect(r.register("explain", "b", liveHandle())).not.toBeNull(); // lock free
  });

  test("fail records failed + errorMsg + releases lock", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("arch_generate", "a", liveHandle())!;
    r.fail(rec.id, "claude -p exited 1");
    expect(r.get(rec.id)!.status).toBe("failed");
    expect(r.get(rec.id)!.errorMsg).toBe("claude -p exited 1");
    expect(r.isBusy()).toBe(false);
  });

  test("SIGKILL'd run records cost null — never a fabricated number (honest boundary)", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("arch_generate", "a", liveHandle(fakeProc(1, {})))!;
    r.cancel(rec.id);
    expect(r.get(rec.id)!.status).toBe("cancelled");
    expect(r.get(rec.id)!.costUsd ?? null).toBeNull();
  });
});

describe("TaskRegistry — cancel aborts + escalates to SIGKILL (止血)", () => {
  test("cancel calls controller.abort() (→ Bun.spawn SIGTERM)", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const lh = liveHandle(fakeProc(222, {}));
    const rec = r.register("arch_generate", "a", lh)!;
    expect(lh.controller.signal.aborted).toBe(false);
    r.cancel(rec.id);
    expect(lh.controller.signal.aborted).toBe(true); // SIGTERM via Bun.spawn signal
    expect(r.get(rec.id)!.status).toBe("cancelled");
  });

  test("escalates to SIGKILL when the pid is STILL ALIVE after the window", async () => {
    const killed: { sig?: string } = {};
    const r = new TaskRegistry(home(), {
      idGen: seqIds,
      killEscalationMs: 5,
      isAlive: () => true, // simulate a subprocess ignoring SIGTERM
    });
    const rec = r.register("arch_generate", "a", liveHandle(fakeProc(333, killed)))!;
    r.cancel(rec.id);
    await new Promise((res) => setTimeout(res, 20));
    expect(killed.sig).toBe("SIGKILL"); // forced kill because still alive
  });

  test("does NOT SIGKILL when the pid already died from SIGTERM (no overkill)", async () => {
    const killed: { sig?: string } = {};
    const r = new TaskRegistry(home(), {
      idGen: seqIds,
      killEscalationMs: 5,
      isAlive: () => false, // SIGTERM already worked
    });
    const rec = r.register("arch_generate", "a", liveHandle(fakeProc(444, killed)))!;
    r.cancel(rec.id);
    await new Promise((res) => setTimeout(res, 20));
    expect(killed.sig).toBeUndefined(); // no SIGKILL — already gone
  });
});

describe("TaskRegistry — real pid liveness (the honest 止血 oracle)", () => {
  test("SIGTERM path: controller.abort() kills a signal-wired subprocess (kill(pid,0)→ESRCH)", async () => {
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 9999 });
    // wire the subprocess to the SAME controller the registry aborts — this is
    // the production path (providers.ts spawns with signal: controller.signal).
    const controller = new AbortController();
    const proc = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
      signal: controller.signal,
      killSignal: "SIGTERM",
    });
    const pid = proc.pid;
    expect(isAliveReal(pid)).toBe(true);
    const rec = r.register("arch_generate", "a", { controller, proc })!;
    r.cancel(rec.id); // abort() → Bun sends SIGTERM (NOT the 9999ms SIGKILL timer)
    await proc.exited;
    expect(isAliveReal(pid)).toBe(false); // gone via SIGTERM alone — orphan eliminated
    expect(r.get(rec.id)!.status).toBe("cancelled");
  });

  test("SIGKILL escalation path: a SIGTERM-ignoring subprocess is force-killed", async () => {
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 50 });
    // trap SIGTERM so the child survives it → forces the SIGKILL escalation.
    const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    expect(isAliveReal(pid)).toBe(true);
    const rec = r.register("arch_generate", "a", { controller: new AbortController(), proc })!;
    r.cancel(rec.id); // abort() is a no-op on this unwired proc → SIGKILL timer fires
    await proc.exited;
    expect(isAliveReal(pid)).toBe(false); // SIGKILL got it despite the SIGTERM trap
    expect(r.get(rec.id)!.status).toBe("cancelled");
  });

  test("spawn-after-cancel hole closed: a subprocess attached AFTER cancel is killed", async () => {
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 50 });
    const rec = r.register("arch_generate", "a", { controller: new AbortController() })!; // no proc yet
    r.cancel(rec.id); // cancelled before the subprocess existed
    // the subprocess spawns late (e.g. context assembly finished after disconnect)
    const proc = Bun.spawn(["bash", "-c", "trap '' TERM; sleep 60"], { stdout: "ignore", stderr: "ignore" });
    const pid = proc.pid;
    r.attachProc(rec.id, proc); // must kill the late subprocess (SIGTERM→SIGKILL)
    await proc.exited;
    expect(isAliveReal(pid)).toBe(false); // not orphaned despite spawning after cancel
  });
});

describe("TaskRegistry — latest() (reconnect snapshot)", () => {
  test("latest() is the running task while one runs, else the most-recently-started terminal record", () => {
    let t = 0;
    const r = new TaskRegistry(home(), { idGen: seqIds, now: () => `2026-06-08T00:00:0${t++}Z` });
    expect(r.latest()).toBeUndefined(); // nothing ever ran
    const a = r.register("arch_generate", "a", liveHandle())!;
    expect(r.latest()!.id).toBe(a.id); // running → it's the latest
    r.finish(a.id, { costUsd: 0.1 });
    expect(r.latest()!.id).toBe(a.id); // terminal but still the only/most-recent
    const b = r.register("explain", "b", liveHandle())!;
    expect(r.latest()!.id).toBe(b.id); // the newer run, even while running
    r.finish(b.id, {});
    expect(r.latest()!.id).toBe(b.id); // most-recently-started terminal wins
    expect(r.latest()!.status).toBe("done");
  });
});

describe("TaskRegistry — idempotent-by-taskId cost ledger", () => {
  test("recording the same taskId twice bills once (idempotent ledger)", () => {
    const reg = new TaskRegistry(home(), {
      idGen: () => "fixed-id",
      now: () => "2026-06-13T00:00:00Z",
    });
    reg.register("arch_generate", "a", liveHandle(fakeProc(1, {})));
    reg.recordCost("fixed-id", 1.5, "real");
    reg.recordCost("fixed-id", 1.5, "real"); // dead-daemon + adopting-daemon both record
    expect(reg.totalCost()).toBe(1.5); // counted ONCE, not 3.00
  });

  test("totalCost sums DISTINCT records (two ids), ignores null-cost records", () => {
    let i = 0;
    const reg = new TaskRegistry(home(), { idGen: () => `id${++i}` });
    const a = reg.register("arch_generate", "a", liveHandle(fakeProc(1, {})))!;
    reg.recordCost(a.id, 1.0, "real");
    reg.finish(a.id); // releases lock; cost already set, finish(null) must not clobber
    const b = reg.register("explain", "b", liveHandle(fakeProc(2, {})))!;
    reg.recordCost(b.id, 0.25, "real");
    reg.finish(b.id);
    expect(reg.totalCost()).toBe(1.25);
  });

  test("recordCost sets basis on the record (audit trail) and is first-write-wins", () => {
    const reg = new TaskRegistry(home(), { idGen: () => "x" });
    reg.register("explain", "a", liveHandle(fakeProc(1, {})));
    reg.recordCost("x", 0.4, "tail_parsed");
    reg.recordCost("x", 99.9, "estimated"); // a later double-record must NOT overwrite
    expect(reg.get("x")!.costUsd).toBe(0.4);
    expect(reg.get("x")!.basis).toBe("tail_parsed");
    expect(reg.totalCost()).toBe(0.4);
  });
});

describe("TaskRegistry — pid+lstart fingerprint reconcile/adoption", () => {
  test("(a) alive pid + lstart MATCH → adopted (status stays running)", () => {
    const h = home();
    // a prior daemon registered a task whose pid is captured with an lstart
    const r1 = new TaskRegistry(h, {
      idGen: seqIds,
      lstartOf: () => "Sat Jun 13 12:00:00 2026",
    });
    const rec = r1.register("arch_generate", "a", liveHandle(fakeProc(4242, {})))!;
    expect(r1.get(rec.id)!.lstart).toBe("Sat Jun 13 12:00:00 2026"); // captured at register
    // restart: the SAME child is still alive AND its start-time matches
    const r2 = new TaskRegistry(h, {
      idGen: seqIds,
      isAlive: () => true,
      lstartOf: () => "Sat Jun 13 12:00:00 2026",
    });
    expect(r2.get(rec.id)!.status).toBe("running"); // adopted, NOT crashed
    expect(r2.isBusy()).toBe(true); // the lock is re-held for the adopted live run
  });

  test("(b) alive pid + lstart MISMATCH (pid reused) → crashed (not falsely adopted)", () => {
    const h = home();
    const r1 = new TaskRegistry(h, {
      idGen: seqIds,
      lstartOf: () => "Sat Jun 13 12:00:00 2026",
    });
    const rec = r1.register("arch_generate", "a", liveHandle(fakeProc(4242, {})))!;
    // restart: pid 4242 is alive but it's a DIFFERENT process (OS reused the pid)
    const r2 = new TaskRegistry(h, {
      idGen: seqIds,
      isAlive: () => true,
      lstartOf: () => "Sat Jun 13 18:30:00 2026", // different start time
    });
    expect(r2.get(rec.id)!.status).toBe("crashed");
    expect(r2.isBusy()).toBe(false);
  });

  test("(c) dead pid → crashed (the file-parse oracle refines this when a result file exists)", () => {
    const h = home();
    const r1 = new TaskRegistry(h, {
      idGen: seqIds,
      lstartOf: () => "Sat Jun 13 12:00:00 2026",
    });
    const rec = r1.register("arch_generate", "a", liveHandle(fakeProc(4242, {})))!;
    const r2 = new TaskRegistry(h, { idGen: seqIds, isAlive: () => false });
    expect(r2.get(rec.id)!.status).toBe("crashed");
    expect(r2.isBusy()).toBe(false);
  });

  test("cancel of an ADOPTED run still kills the real detached child (no cost-loss orphan)", async () => {
    const h = home();
    // a real long-lived child stands in for the surviving detached paid run
    const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
    const realPid = proc.pid;
    const lstart = "Sat Jun 13 12:00:00 2026";
    const r1 = new TaskRegistry(h, { idGen: () => "adopted", lstartOf: () => lstart });
    r1.register("arch_generate", "a", liveHandle(fakeProc(realPid, {})));
    // restart: the child is genuinely alive + lstart matches → ADOPTED (no live handle)
    const r2 = new TaskRegistry(h, {
      idGen: seqIds,
      isAlive: isAliveReal,
      killEscalationMs: 30,
      lstartOf: () => lstart,
    });
    expect(r2.get("adopted")!.status).toBe("running"); // adopted
    expect(isAliveReal(realPid)).toBe(true);
    r2.cancel("adopted"); // must terminate the real child despite having no live handle
    await proc.exited;
    expect(isAliveReal(realPid)).toBe(false); // the detached child was actually killed
    expect(r2.get("adopted")!.status).toBe("cancelled");
  });

  test("(risk 4) an adopted task does NOT re-arm the wall-clock timeout-kill timer", async () => {
    const h = home();
    const r1 = new TaskRegistry(h, {
      idGen: seqIds,
      lstartOf: () => "Sat Jun 13 12:00:00 2026",
    });
    const rec = r1.register("arch_generate", "a", liveHandle(fakeProc(4242, {})), {
      timeoutMs: 10_000,
    })!;
    // restart adopts the live child — but there is NO live proc handle to kill,
    // so re-arming a timeout-kill timer would be a no-op at best, a stale fire at
    // worst. The adopted record must simply stay running with no new timer.
    const r2 = new TaskRegistry(h, {
      idGen: seqIds,
      isAlive: () => true,
      killEscalationMs: 5,
      lstartOf: () => "Sat Jun 13 12:00:00 2026",
    });
    expect(r2.get(rec.id)!.status).toBe("running");
    await new Promise((res) => setTimeout(res, 25));
    expect(r2.get(rec.id)!.status).toBe("running"); // never flipped by a re-armed timer
  });
});

describe("TaskRegistry — daemon-restart honesty", () => {
  test("a prior running record with a dead pid loads as crashed (never falsely running)", () => {
    const h = home();
    const r1 = new TaskRegistry(h, { idGen: seqIds });
    const rec = r1.register("arch_generate", "a", liveHandle(fakeProc(999999, {})))!;
    // simulate a daemon crash: tasks.json has a `running` record, process is gone.
    expect(JSON.parse(readFileSync(join(h, "tasks.json"), "utf8"))[0].status).toBe("running");
    // a NEW registry (= daemon restart) reconciles
    const r2 = new TaskRegistry(h, { idGen: seqIds, isAlive: () => false });
    expect(r2.get(rec.id)!.status).toBe("crashed");
    expect(r2.isBusy()).toBe(false); // no false lock held by a dead task
  });
});

describe("TaskRegistry — daemon stop spares detached in-flight children", () => {
  test("stop() does NOT abort the controller nor kill a detached in-flight child", () => {
    const killed: { sig?: string } = {};
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const lh = { ...liveHandle(fakeProc(555, killed)), detached: true };
    const rec = r.register("arch_generate", "a", lh)!;
    r.stop(); // daemon shutdown — the detached child must survive to finish + write its file
    expect(lh.controller.signal.aborted).toBe(false); // NOT aborted (no SIGTERM)
    expect(killed.sig).toBeUndefined(); // NOT killed
    // the record is NOT flipped to a terminal — the child is still running for real
    expect(r.get(rec.id)!.status).toBe("running");
  });

  test("stop() clears the wall-clock timeout timer so it cannot fire during/after shutdown", async () => {
    const killed: { sig?: string } = {};
    const r = new TaskRegistry(home(), { idGen: seqIds, killEscalationMs: 5 });
    const lh = { ...liveHandle(fakeProc(556, killed)), detached: true };
    const rec = r.register("arch_generate", "a", lh, { timeoutMs: 10 })!;
    r.stop();
    await new Promise((res) => setTimeout(res, 30));
    expect(killed.sig).toBeUndefined(); // the timeout-kill never fired
    expect(r.get(rec.id)!.status).toBe("running"); // not flipped to crashed by a stale timer
  });

  test("cancel() STILL kills (user cancel is unchanged by the stop-spare rule)", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const lh = { ...liveHandle(fakeProc(557, {})), detached: true };
    const rec = r.register("arch_generate", "a", lh)!;
    r.cancel(rec.id);
    expect(lh.controller.signal.aborted).toBe(true); // explicit cancel still aborts → SIGTERM
    expect(r.get(rec.id)!.status).toBe("cancelled");
  });
});

describe("TaskRegistry — startup scavenger adopts orphan result files", () => {
  const COMPLETE = JSON.stringify([
    { type: "result", result: "ok", total_cost_usd: 0.77, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  ]);
  function seedOut(h: string, id: string, content: string): void {
    const dir = join(h, "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.out`), content);
  }

  test("a .out file absent from tasks.json → adopted as a record after construction (oracle-classified)", () => {
    const h = home();
    seedOut(h, "orphan-1", COMPLETE); // no tasks.json entry for it
    const reg = new TaskRegistry(h, { idGen: seqIds });
    const rec = reg.get("orphan-1");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("done");
    expect(rec!.costUsd).toBe(0.77);
    expect(rec!.basis).toBe("real");
    expect(reg.totalCost()).toBe(0.77); // billed via the idempotent ledger
  });

  test("corrupt tasks.json no longer LEAKS the orphan (the scavenger picks it up)", () => {
    const h = home();
    writeFileSync(join(h, "tasks.json"), "{ this is not valid json"); // corrupt → load starts clean
    seedOut(h, "orphan-2", COMPLETE);
    const reg = new TaskRegistry(h, { idGen: seqIds });
    expect(reg.get("orphan-2")?.status).toBe("done"); // recovered despite the corrupt registry
  });

  test("a still-writing orphan (truncated + FRESH mtime) is DOWNGRADED to crashed, NOT left running", () => {
    const h = home();
    // a truncated, fresh-mtime .out → the file-parse oracle alone returns `running`
    // (still being written). But the scavenger has no live handle for it, so a
    // `running` record would falsely surface in all()/latest() with no process.
    const partial = '[{"type":"result","total_cost_usd":0.50,"usage":{"input_tokens":2000,';
    const dir = join(h, "tasks");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "orphan-fresh.out");
    writeFileSync(p, partial);
    const now = Date.now() / 1000; // fresh mtime (well within RESULT_FILE_FRESH_MS)
    utimesSync(p, now, now);
    const reg = new TaskRegistry(h, { idGen: seqIds });
    const rec = reg.get("orphan-fresh");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("crashed"); // NOT "running" — no live handle, mirror reconcileDead()
    expect(rec!.costUsd ?? null).toBeNull(); // honest: a still-writing orphan we can't drive
    expect(rec!.endedTs).toBeDefined(); // terminal records carry an endedTs
    expect(reg.isBusy()).toBe(false); // never holds the one-at-a-time lock
  });

  test("a .out whose id IS already in records is NOT double-created by the scavenger", () => {
    const h = home();
    const r1 = new TaskRegistry(h, { idGen: () => "known", lstartOf: () => "x" });
    r1.register("arch_generate", "a", liveHandle(fakeProc(123, {})));
    seedOut(h, "known", COMPLETE); // same id as the live record
    // restart with a DEAD pid → the known record reconciles via the oracle (its own .out)
    const r2 = new TaskRegistry(h, { idGen: seqIds, isAlive: () => false });
    expect(r2.all().filter((t) => t.id === "known")).toHaveLength(1); // not duplicated
  });
});

describe("classifyResultFile — file-parse oracle", () => {
  const ARCH_MODEL = "sonnet" as const;
  function outFile(content: string, mtimeAgeMs?: number): string {
    const d = home();
    const p = join(d, "x.out");
    writeFileSync(p, content);
    if (mtimeAgeMs !== undefined) {
      const t = (Date.now() - mtimeAgeMs) / 1000;
      utimesSync(p, t, t);
    }
    return p;
  }

  test("(a) complete JSON with usage → done + REAL cost from total_cost_usd, basis=real", () => {
    const stream = [
      { type: "result", result: "ok", total_cost_usd: 1.23, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    ];
    const res = classifyResultFile(outFile(JSON.stringify(stream)), { model: ARCH_MODEL });
    expect(res.status).toBe("done");
    expect(res.costUsd).toBe(1.23);
    expect(res.basis).toBe("real");
  });

  test("(a') complete JSON, usage present but total_cost_usd null → done + cost derived from tokens", () => {
    const stream = [
      { type: "result", result: "ok", usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    ];
    const res = classifyResultFile(outFile(JSON.stringify(stream)), { model: ARCH_MODEL });
    expect(res.status).toBe("done");
    expect(res.costUsd).toBeGreaterThan(0); // archCostFromUsage on 1M input tokens
    expect(res.basis).toBe("derived");
  });

  test("(b) truncated JSON, mtime STALE (complete-but-cut), tail-salvageable → done, basis=tail_parsed (NOT $0 crashed)", () => {
    // a result-event tail cut after the usage block — JSON.parse fails, tail parses
    const cut = '...,{"type":"result","total_cost_usd":0.50,"usage":{"input_tokens":2000,"output_tokens":100,';
    const res = classifyResultFile(outFile(cut, 60_000), { model: ARCH_MODEL });
    expect(res.status).toBe("done");
    expect(res.costUsd).toBe(0.5);
    expect(res.basis).toBe("tail_parsed");
  });

  test("(b') truncated JSON, mtime FRESH (still writing) → running (do NOT finalize)", () => {
    const partial = '[{"type":"result","total_cost_usd":0.50,"usage":{"input_tokens":2000,';
    const res = classifyResultFile(outFile(partial, 100), { model: ARCH_MODEL });
    expect(res.status).toBe("running"); // incomplete + fresh → still in flight, leave it
  });

  test("(c) empty file → crashed, cost null", () => {
    const res = classifyResultFile(outFile("   \n", 60_000), { model: ARCH_MODEL });
    expect(res.status).toBe("crashed");
    expect(res.costUsd ?? null).toBeNull();
  });

  test("(c') truncated + STALE + NOTHING salvageable → crashed (honest, no fabricated cost)", () => {
    const res = classifyResultFile(outFile("garbage not json at all", 60_000), { model: ARCH_MODEL });
    expect(res.status).toBe("crashed");
    expect(res.costUsd ?? null).toBeNull();
  });

  test("(d) COMPLETE valid JSON with NO result event + FRESH mtime → crashed (not falsely running)", () => {
    // a fully-parseable stream that carries only non-result events → the file is
    // done being written; the fresh-mtime 'still writing' heuristic must NOT apply
    // (else this record would hang 'running' forever holding nothing).
    const noResult = JSON.stringify([{ type: "system" }, { type: "assistant" }]);
    const res = classifyResultFile(outFile(noResult, 100), { model: ARCH_MODEL });
    expect(res.status).toBe("crashed");
    expect(res.costUsd ?? null).toBeNull();
  });
});

function isAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Replicates defaultLstartOf from task-registry (not exported) for test fingerprint matching. */
function lstartOfReal(pid: number): string | undefined {
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
    if (!out.success) return undefined;
    const s = out.stdout.toString().trim();
    return s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

describe("TaskRegistry — finalize watcher", () => {
  test("adopted alive child is finalized by the watcher when it exits", async () => {
    const home = mkdtempSync(join(tmpdir(), "q4-watch-"));
    const out = join(home, "tasks", "live-1.out");
    mkdirSync(join(home, "tasks"), { recursive: true });

    // A real child: writes a complete result JSON, lingers briefly, then exits.
    const child = Bun.spawn(
      ["bash", "-c", `printf '[{"type":"result","total_cost_usd":0.42,"usage":{}}]' > '${out}'; sleep 0.3`],
      { stdout: "ignore", stderr: "ignore" },
    );
    const pid = child.pid!;

    // Capture lstart IMMEDIATELY (same syscall the registry uses — must match).
    const lstart = lstartOfReal(pid);
    expect(lstart).toBeDefined(); // sanity: child is alive

    writeFileSync(
      join(home, "tasks.json"),
      JSON.stringify([{ id: "live-1", kind: "arch_generate", repo: "r", status: "running", pid, lstart, startedTs: new Date().toISOString() }]),
    );

    const reg = new TaskRegistry(home, { pollMs: 20 });
    // load() is called in the constructor; with `pollMs` option injected it should
    // adopt live-1 (alive + lstart match) and start the finalize watcher.
    expect(reg.get("live-1")?.status).toBe("running"); // still alive
    expect(reg.activeTaskId()).not.toBeNull(); // lock re-held

    await child.exited;
    // Poll until the watcher finalizes (cap at 2 s).
    const deadline = Date.now() + 2000;
    while (reg.get("live-1")?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (reg.get("live-1")?.status === "running") {
      throw new Error("finalize watcher did not fire within 2s (CI overload?)");
    }

    const rec = reg.get("live-1")!;
    expect(rec.status).toBe("done");
    expect(rec.costUsd).toBe(0.42);
    // Double-bill guard: cost recorded exactly once (idempotent ledger).
    expect(reg.totalCost()).toBe(0.42);
    expect(reg.activeTaskId()).toBeNull(); // lock released by the watcher

    reg.stopWatchers();
    rmSync(home, { recursive: true, force: true });
  });

  test("watcher callback throw does NOT crash the daemon — lock released, watcher stopped", async () => {
    // RED evidence: without the try/catch in startFinalizeWatcher, a classifyFn
    // that throws would propagate out of setInterval uncaught and terminate the
    // process. With the try/catch it must degrade gracefully.
    const h = mkdtempSync(join(tmpdir(), "q4-watch-crash-"));
    mkdirSync(join(h, "tasks"), { recursive: true });

    const pid = 1; // any non-alive pid — isAlive returns false immediately
    writeFileSync(
      join(h, "tasks.json"),
      JSON.stringify([{ id: "crash-1", kind: "arch_generate", repo: "r", status: "running", pid, lstart: "x", startedTs: new Date().toISOString() }]),
    );

    const reg = new TaskRegistry(h, {
      pollMs: 20,
      isAlive: () => false, // child appears exited immediately → triggers classify
      lstartOf: () => "x",  // lstart match → adopted
      classifyFn: () => { throw new Error("disk full"); }, // injected failure
    });

    // The test process must still be alive here (the throw was caught).
    // Wait for the watcher to fire + handle the error.
    const deadline = Date.now() + 2000;
    while (reg.watcherCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Daemon is still alive (we're executing this line).
    expect(reg.watcherCount()).toBe(0); // watcher stopped after error
    expect(reg.activeTaskId()).toBeNull(); // lock released despite the throw

    reg.stopWatchers();
    rmSync(h, { recursive: true, force: true });
  });
});

describe("TaskRegistry — finish() errorMsg (malformed-generate diagnosability)", () => {
  test("malformed outcome: finish() with errorMsg → record has errorMsg set, status=done, costUsd recorded", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("arch_generate", "webapp", liveHandle())!;
    // Simulate what the daemon route now passes for a malformed outcome.
    r.finish(rec.id, {
      costUsd: 1.45,
      errorMsg: "malformed: failed to parse arch doc [output_tokens:12345]",
    });
    const stored = r.get(rec.id)!;
    expect(stored.status).toBe("done");
    expect(stored.costUsd).toBe(1.45);
    expect(stored.errorMsg).toBe("malformed: failed to parse arch doc [output_tokens:12345]");
    expect(r.isBusy()).toBe(false);
  });

  test("generated (success) outcome: finish() with no errorMsg → record has no errorMsg", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("arch_generate", "webapp", liveHandle())!;
    // Successful generate: no errorMsg passed.
    r.finish(rec.id, { costUsd: 0.33 });
    const stored = r.get(rec.id)!;
    expect(stored.status).toBe("done");
    expect(stored.costUsd).toBe(0.33);
    expect(stored.errorMsg).toBeUndefined();
  });

  test("integrity_failed outcome: finish() with errorMsg → record has errorMsg", () => {
    const r = new TaskRegistry(home(), { idGen: seqIds });
    const rec = r.register("arch_generate", "webapp", liveHandle())!;
    r.finish(rec.id, {
      costUsd: 0.9,
      errorMsg: "integrity_failed: arch-model write failed: checksum mismatch",
    });
    const stored = r.get(rec.id)!;
    expect(stored.status).toBe("done");
    expect(stored.errorMsg).toMatch(/^integrity_failed:/);
  });
});
