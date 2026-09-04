// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Task 9: Phase 2 (`finalizeCase1`) wired into the distil-worker acted/appended
// branch. These tests exercise the `finalizeFn` seam on `SweepDeps` — never
// real git/network — per spec §6 (rule linkage — only `appended`) and §8
// (lifecycle: preserve `.pre.json` on writer throw).
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueuePending, pendingQueuePath, readPending } from "../../src/memory/pending-queue";
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

function tmp() { return mkdtempSync(join(tmpdir(), "dw-case1-")); }

describe("distil-worker Phase 2 finalize wiring (Task 9)", () => {
  it("acted + appended → finalizeFn called once with capture_id + rule.id + verified_anchor", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      finalizeFn,
    });

    expect(res.written).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      capture_id: "case1-ab",
      cwd: "/cwd",
      stateBase: state,
      rule: { id: "lr-9" },
      verified_anchor: { file: "a.ts" },
    });

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("finalizeFn receives the flagged line + fingerprint and the rule's text/category", async () => {
    // Two contract widenings: `verified_anchor` now carries WHICH line the
    // oracle confirmed fixed (not just the file), and `rule` carries the
    // distilled text/category so `provenance-private.json` freezes them
    // instead of storing an id-only pointer into a churning memory.json.
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({
      anchors: [{ file: "a.ts", line: 42, tool: "tsc" as const, fingerprint: "fp-flagged" }],
    }));
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({
        written: "appended" as const,
        rule_id: "lr-9",
        rule_text: "Always null-check user before .email",
        rule_category: "null-safety",
      }),
      finalizeFn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].rule).toEqual({
      id: "lr-9", text: "Always null-check user before .email", category: "null-safety",
    });
    expect(calls[0].verified_anchor).toMatchObject({
      file: "a.ts", line: 42, fingerprint: "fp-flagged",
    });

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("a writer that omits rule_text/rule_category still finalizes (falls back to empty, never skips capture)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      finalizeFn,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].rule).toEqual({ id: "lr-9", text: "", category: "" });

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("writer THROWS → finalizeFn NOT called, entry survives for retry", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => { throw new Error("claude -p exited 143"); },
      finalizeFn,
    });

    expect(calls).toHaveLength(0);
    expect(res.pending).toBe(1);
    const survivors = await readPending(pendingQueuePath(state));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].distil_attempts).toBe(1);

    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  for (const outcome of ["bumped", "dup", "garbage"] as const) {
    it(`acted + ${outcome} → finalizeFn NOT called (only 'appended' is a clean case1→rule)`, async () => {
      const home = tmp(), state = tmp();
      await enqueuePending(pendingQueuePath(state), entry());
      const calls: any[] = [];
      const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

      await sweepEntriesOnce(home, state, "/cwd", {
        oracleFn: async () => "acted",
        writeFn: async () => ({ written: outcome, rule_id: "lr-9" }),
        finalizeFn,
      });

      expect(calls).toHaveLength(0);
      rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
    });
  }

  it("appended but entry has no capture_id → finalizeFn NOT called", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({ capture_id: undefined }));
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      finalizeFn,
    });

    expect(calls).toHaveLength(0);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("appended but anchors[0].file is UNSAFE (absolute) → sanitized-reject, finalizeFn NOT called", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({
      anchors: [{ file: "/etc/passwd", line: 1, tool: "tsc" as const, fingerprint: "fp" }],
    }));
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      finalizeFn,
    });

    expect(calls).toHaveLength(0); // an unsanitizable anchor path never reaches finalizeFn
    expect(res.written).toBe(1);   // writer accounting still unaffected
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("appended but no anchors[0] → finalizeFn NOT called (guarded, no throw)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry({ anchors: [] }));
    const calls: any[] = [];
    const finalizeFn = async (a: any) => { calls.push(a); return "finalized" as const; };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      finalizeFn,
    });

    expect(calls).toHaveLength(0);
    expect(res.written).toBe(1); // writer accounting unaffected by the missing anchor
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("finalizeFn THROWS → sweep accounting unaffected (fail-soft, not miscounted as write_failed)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const finalizeFn = async () => { throw new Error("finalize blew up"); };

    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
      finalizeFn,
    });

    expect(res.written).toBe(1); // still counted — finalize failure must not affect writer accounting
    expect(res.pending).toBe(0); // still dropped — not requeued as a write_failed survivor
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("no finalizeFn override → default wiring uses the real finalizeCase1 (gate OFF by default, never throws)", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());

    // No finalizeFn supplied — sweepEntriesOnce must fall back to the real
    // finalizeCase1 + nodeFinalizeDeps wiring. capture_case1 is OFF by default
    // (no config.json in `home`), so finalizeCase1 gates internally and
    // resolves "skipped" — this just proves the wiring doesn't throw/break
    // the sweep when the real default path is exercised.
    const res = await sweepEntriesOnce(home, state, "/cwd", {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-9" }),
    });

    expect(res.written).toBe(1);
    expect(res.pending).toBe(0);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });
});
