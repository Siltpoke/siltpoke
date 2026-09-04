// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueuePending, pendingQueuePath, readPending } from "../../src/memory/pending-queue";
import { sweepEntriesOnce, runDistilWorker, MAX_DISTIL_ATTEMPTS, type SweepDeps } from "../../src/memory/distil-worker";

function entry(over: Partial<any> = {}) {
  return {
    critique_id: "c-1", session_id: "s", created_sha: null,
    created_at: new Date().toISOString(), hooks_elapsed: 0,
    status: "pending" as const, severity: "high" as const, finding_text: "f",
    anchors: [{ file: "a.ts", line: 1, tool: "tsc" as const, fingerprint: "fp" }],
    distil_attempts: 0, ...over,
  };
}

function tmp() { return mkdtempSync(join(tmpdir(), "dw-")); }

describe("sweepEntriesOnce", () => {
  it("acted + reflection success -> writes rule, drops entry", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    let wrote = false;
    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => { wrote = true; return { written: "appended" }; },
    });
    expect(wrote).toBe(true);
    expect(res.written).toBe(1);
    expect(await readPending(pendingQueuePath(state))).toHaveLength(0);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("🔑 awaits a SLOW reflection to completion (LLM runs here, not in a hook)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    let finished = false;
    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => {
        await new Promise((r) => setTimeout(r, 120)); // simulate a ~30s claude -p
        finished = true; return { written: "appended" };
      },
    });
    expect(finished).toBe(true);        // fully awaited — no SIGTERM/interrupt class
    expect(res.written).toBe(1);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("acted + reflection throws -> keeps entry, bumps distil_attempts", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => { throw new Error("claude -p exited with code 143"); },
    });
    const survivors = await readPending(pendingQueuePath(state));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].distil_attempts).toBe(1);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("acted + attempts at MAX -> drops (abstain)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({ distil_attempts: MAX_DISTIL_ATTEMPTS - 1 }));
    await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => { throw new Error("still broken"); },
    });
    expect(await readPending(pendingQueuePath(state))).toHaveLength(0);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("not_yet -> keeps entry, bumps hooks_elapsed", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    await sweepEntriesOnce(home, state, "/cwd", { oracleFn: async () => "not_yet" });
    const survivors = await readPending(pendingQueuePath(state));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].hooks_elapsed).toBe(1);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("TTL_HOOKS reached -> expires (drops)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({ hooks_elapsed: 2 })); // bumps to 3 = TTL_HOOKS
    const res = await sweepEntriesOnce(home, state, "/cwd", { oracleFn: async () => "not_yet" });
    expect(res.expired).toBe(1);
    expect(await readPending(pendingQueuePath(state))).toHaveLength(0);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });
});

// --- ported from tests/memory/sweep-pending.test.ts (Build 2 drift/negative-verdict
// regressions) — same behavioral cases, sweepPending -> sweepEntriesOnce. Do NOT delete
// the original file/tests (Task 5 retires sweep-pending.ts separately). ---
describe("sweepEntriesOnce (ported from sweepPending)", () => {
  const mk = (id: string, hooks = 0): any => ({
    critique_id: id, session_id: "s1", created_sha: "sha", created_at: new Date().toISOString(),
    hooks_elapsed: hooks, status: "pending", severity: "medium", finding_text: "fix it",
    anchors: [{ file: "f.ts", line: 3, tool: "git-diff", fingerprint: "fp" }],
  });

  it("not_yet keeps the entry (never delete on negative) + bumps hooks_elapsed (AC7)", async () => {
    const dir = tmp();
    await enqueuePending(pendingQueuePath(dir), mk("c-1"));
    const r = await sweepEntriesOnce(dir, dir, "/x", { oracleFn: async () => "not_yet", writeFn: async () => ({ written: "appended" }) });
    expect(r.pending).toBe(1);
    const left = await readPending(pendingQueuePath(dir));
    expect(left[0].hooks_elapsed).toBe(1);
    rmSync(dir, { recursive: true });
  });

  it("acted writes then drops the entry (AC1)", async () => {
    const dir = tmp();
    await enqueuePending(pendingQueuePath(dir), mk("c-1"));
    let calls = 0;
    const r = await sweepEntriesOnce(dir, dir, "/x", { oracleFn: async () => "acted", writeFn: async () => { calls++; return { written: "appended" }; } });
    expect(calls).toBe(1);
    expect(r.written).toBe(1);
    expect(await readPending(pendingQueuePath(dir))).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it("TTL expiry drops without writing (AC3)", async () => {
    const dir = tmp();
    await enqueuePending(pendingQueuePath(dir), mk("c-1", 3)); // already at TTL_HOOKS
    let calls = 0;
    const r = await sweepEntriesOnce(dir, dir, "/x", { oracleFn: async () => "not_yet", writeFn: async () => { calls++; return { written: "appended" }; } });
    expect(calls).toBe(0);
    expect(r.expired).toBe(1);
    expect(await readPending(pendingQueuePath(dir))).toHaveLength(0);
    rmSync(dir, { recursive: true });
  });

  it("oracle throw is treated as abstain — entry kept, not written, not dropped", async () => {
    const dir = tmp();
    await enqueuePending(pendingQueuePath(dir), mk("c-err"));
    let writes = 0;
    const r = await sweepEntriesOnce(dir, dir, "/x", {
      oracleFn: async () => { throw new Error("oracle boom"); },
      writeFn: async () => { writes++; return { written: "appended" }; },
    });
    expect(writes).toBe(0);
    expect(r.pending).toBe(1);
    const left = await readPending(pendingQueuePath(dir));
    expect(left[0].hooks_elapsed).toBe(1);
    rmSync(dir, { recursive: true });
  });

  it("acted verdict whose writeFn dedups/garbage-drops does not overcount `written` (still drops the entry)", async () => {
    const dir = tmp();
    await enqueuePending(pendingQueuePath(dir), mk("c-1"));
    let calls = 0;
    const r = await sweepEntriesOnce(dir, dir, "/x", {
      oracleFn: async () => "acted",
      writeFn: async () => { calls++; return { written: "dup" }; },
    });
    expect(calls).toBe(1);
    expect(r.written).toBe(0); // adjudicated but nothing persisted — must not count as a write
    expect(await readPending(pendingQueuePath(dir))).toHaveLength(0); // still dropped (acted)
    rmSync(dir, { recursive: true });
  });

  it("writer throw on an acted entry keeps it pending (retry, distil_attempts=1), does not abort the sweep", async () => {
    const dir = tmp();
    await enqueuePending(pendingQueuePath(dir), mk("c-1"));
    await enqueuePending(pendingQueuePath(dir), mk("c-2"));
    const r = await sweepEntriesOnce(dir, dir, "/x", {
      oracleFn: async () => "acted",
      writeFn: async () => { throw new Error("llm boom"); },
    });
    expect(r.written).toBe(0);
    expect(r.pending).toBe(2); // both kept, batch not aborted
    const left = await readPending(pendingQueuePath(dir));
    expect(left).toHaveLength(2);
    expect(left.every((e) => e.distil_attempts === 1)).toBe(true); // Build-2's new retry budget bump
    rmSync(dir, { recursive: true });
  });
});

// Task 7: SweepDeps.writeFn's return type must carry rule_id (Task 9 needs it
// to link the just-written rule at Phase-2 finalize).
//
// The type-level pin below is deliberately a `keyof` check, not "assign an
// object literal with an extra `rule_id` field and see if tsc complains" —
// verified by hand (see task-7-report.md) that the latter does NOT fail
// against the narrow (pre-widen) type: TypeScript's excess-property check
// does not propagate through an async arrow function's contextually-typed,
// Promise-wrapped return position, so `writeFn: async () => ({ written:
// "appended", rule_id: "x" })` type-checks fine even when `rule_id` isn't in
// the declared return type at all — it's silently accepted and silently
// dropped. A `keyof` check is the correct RED/GREEN oracle here because
// `rule_id` is OPTIONAL: an `extends { rule_id?: string }` structural check
// is also a false-negative (a type missing the property entirely is still
// structurally assignable to a type where the property is optional). Only
// checking for `"rule_id"` in `keyof <the type>` distinguishes "key present
// (even optional)" from "key absent".
type WriteFnReturn = Awaited<ReturnType<NonNullable<SweepDeps["writeFn"]>>>;
type _AssertWriteFnReturnHasRuleIdKey = "rule_id" extends keyof WriteFnReturn ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typePin: _AssertWriteFnReturnHasRuleIdKey = true;

describe("SweepDeps.writeFn carries rule_id (Task 7)", () => {
  it("accepts a writeFn returning { written, rule_id } and still counts the write", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
    });
    expect(res.written).toBe(1);
    expect(await readPending(pendingQueuePath(state))).toHaveLength(0);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });
});

describe("runDistilWorker single-flight", () => {
  it("second concurrent worker no-ops while the first holds the lock", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    let writeCalls = 0;
    const slowWrite = async () => { await new Promise((r) => setTimeout(r, 150)); writeCalls++; return { written: "appended" as const }; };
    const [a, b] = await Promise.all([
      runDistilWorker(home, state, "/cwd", { oracleFn: async () => "acted", writeFn: slowWrite }),
      runDistilWorker(home, state, "/cwd", { oracleFn: async () => "acted", writeFn: slowWrite }),
    ]);
    const skipped = [a, b].filter((r) => "skipped" in r);
    expect(skipped).toHaveLength(1);   // exactly one was locked out
    expect(writeCalls).toBe(1);        // no double-append
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });
});
