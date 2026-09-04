// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Task 10: orphan GC (`gcCase1Candidates`) wired into `sweepEntriesOnce` as an
// opportunistic, fail-soft housekeeping pass. These tests exercise the `gcFn`
// seam on `SweepDeps` — never real fs/git — per spec §8 (GC prunes by age +
// orphan status; never a gate; a GC failure must never affect the sweep's
// returned counts).
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueuePending, pendingQueuePath } from "../../src/memory/pending-queue";
import { sweepEntriesOnce } from "../../src/memory/distil-worker";

function entry(over: Partial<any> = {}) {
  return {
    critique_id: "c-1", session_id: "s", created_sha: null,
    created_at: new Date().toISOString(), hooks_elapsed: 0,
    status: "pending" as const, severity: "high" as const, finding_text: "f",
    anchors: [{ file: "a.ts", line: 1, tool: "tsc" as const, fingerprint: "fp" }],
    distil_attempts: 0, capture_id: "case1-ab", ...over,
  };
}

function tmp() { return mkdtempSync(join(tmpdir(), "dw-gc-")); }

describe("distil-worker orphan GC wiring (Task 10)", () => {
  it("gcFn is called once per sweep with livePendingIds from the surviving (still-pending) entries", async () => {
    const home = tmp(), state = tmp();
    // not_yet -> survives -> its capture_id must be in livePendingIds so its
    // pre-candidate is protected from GC even if it's old.
    await enqueuePending(pendingQueuePath(state), entry({ capture_id: "case1-cccc3" }));
    const calls: any[] = [];
    const gcFn = async (stateBase: string, opts: any) => { calls.push({ stateBase, opts }); return 0; };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "not_yet",
      gcFn,
    });

    expect(res.pending).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].stateBase).toBe(state);
    expect(calls[0].opts.livePendingIds).toBeInstanceOf(Set);
    expect(calls[0].opts.livePendingIds.has("case1-cccc3")).toBe(true);
    expect(calls[0].opts.maxAgeMs).toBeGreaterThan(0);
    expect(calls[0].opts.now).toBeInstanceOf(Date);

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("a dropped (acted+appended) entry's capture_id is NOT in livePendingIds — it's no longer pending", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({ capture_id: "case1-dddd4" }));
    const calls: any[] = [];
    const gcFn = async (_sb: string, opts: any) => { calls.push(opts); return 0; };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      gcFn,
    });

    expect(res.pending).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].livePendingIds.has("case1-dddd4")).toBe(false);
    expect(calls[0].livePendingIds.size).toBe(0);

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("gcFn THROWS → sweep's returned counts are unaffected (fail-soft)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const gcFn = async () => { throw new Error("gc blew up"); };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      gcFn,
    });

    expect(res.written).toBe(1); // writer accounting unaffected by the GC throw
    expect(res.pending).toBe(0);

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("no gcFn override → default wiring uses the real gcCase1Candidates + nodeGcDeps, never throws", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());

    // No gcFn supplied — sweepEntriesOnce must fall back to the real
    // gcCase1Candidates + nodeGcDeps wiring. The candidates dir under `state`
    // doesn't exist yet, so the real readdir fails and gcCase1Candidates
    // fail-softs to 0 — this just proves the default wiring doesn't
    // throw/break the sweep.
    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
    });

    expect(res.written).toBe(1);
    expect(res.pending).toBe(0);

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });
});
