// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Task 6 — automated proof of the moat's positive n=1: an `acted` pending
// entry, driven through the PUBLIC entry point (`runDistilWorker`, the
// lock-wrapped function the detached worker process actually calls — not
// the inner `sweepEntriesOnce`), persists an `origin: "acted_on"` learned
// rule to the REAL memory store on a REAL filesystem and drains the queue.
// The manual Dogfood-B version of this proof is Task 8.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDistilWorker } from "../../src/memory/distil-worker";
import {
  enqueuePending,
  readPending,
  pendingQueuePath,
  type PendingCritique,
} from "../../src/memory/pending-queue";
import { appendLearnedRule, readMemory, type LearnedRule } from "../../src/memory/memory";

test("runDistilWorker: acted pending entry -> real appendLearnedRule write -> origin:acted_on rule persisted, queue drained", async () => {
  // Separate home (global memory store) and state (project pending-queue)
  // bases, mirroring the real global-vs-per-project split — NOT the same
  // tmpdir, so the test can't accidentally pass by conflating the two.
  const homeBase = await mkdtemp(join(tmpdir(), "distil-int-home-"));
  const stateBase = await mkdtemp(join(tmpdir(), "distil-int-state-"));
  const cwd = stateBase;

  const queuePath = pendingQueuePath(stateBase);
  const entry: PendingCritique = {
    critique_id: "c-int-1",
    session_id: "s-int",
    created_sha: "deadbeef",
    created_at: new Date().toISOString(),
    hooks_elapsed: 0,
    status: "pending",
    severity: "medium",
    finding_text: "missing await on async db call before returning the result",
    anchors: [{ file: "svc.ts", line: 10, tool: "tsc", fingerprint: "fp-int-1" }],
    distil_attempts: 0,
  };
  await enqueuePending(queuePath, entry);

  try {
    // Stub only the two adjudication hooks (oracle + reflection/distil).
    // The rest of the path — lock acquisition, queue read/write,
    // appendLearnedRule, and writeMemory — is the REAL production code
    // running against a REAL filesystem, which is the point of this test.
    const res = await runDistilWorker(homeBase, stateBase, cwd, {
      oracleFn: async () => "acted",
      writeFn: async (base, bumped) => {
        const rule: LearnedRule = {
          id: "lr-int-1",
          rule: "Always await async db calls before returning results to the caller",
          category: "async-safety",
          created_at: new Date().toISOString(),
          applied_count: 0,
          effectiveness: "neutral",
          source: `distil-worker-integration:${bumped.critique_id}`,
          applies_to_file_types: ["ts"],
          confidence: "medium",
          origin: "acted_on",
        };
        const r = await appendLearnedRule(base, rule);
        return { written: r.appended ? "appended" : "dup" };
      },
    });

    if ("skipped" in res) throw new Error("unexpected lock contention in a single-worker test");
    expect(res.written).toBe(1);

    const mem = await readMemory(homeBase);
    const persisted = mem!.learned_rules.find((r) => r.id === "lr-int-1");
    expect(persisted).toBeDefined();
    expect(persisted!.origin).toBe("acted_on");

    const remaining = await readPending(queuePath);
    expect(remaining).toHaveLength(0);
  } finally {
    await rm(homeBase, { recursive: true, force: true });
    await rm(stateBase, { recursive: true, force: true });
  }
});
