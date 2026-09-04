// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
/**
 * Eval §3 step 1, T5 — the write-half adjudication log.
 *
 * The queue and the verdicts already existed; they were simply discarded, so
 * `acted_rate` was not computable and abstains were invisible. One line per
 * adjudication makes enqueue rate, adjudication rate, acted_rate, the abstain
 * distribution, the garbage/dup rate and the TTL-drop rate all fall out of the
 * same file.
 *
 * Naming note asserted below: the field is `acted`, never `precision`. Whether
 * a developer acted on a finding is a PRODUCT signal, not a correctness one.
 *
 * Spec: an internal design note §2.2
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepEntriesOnce } from "../../src/memory/distil-worker";
import {
  adjudicationLogPath,
  type AdjudicationRecord,
} from "../../src/memory/adjudication-log";
import { writePending, pendingQueuePath, type PendingCritique } from "../../src/memory/pending-queue";
import { lineContentFingerprint } from "../../src/memory/line-fingerprint";

const FILE = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");

function pending(overrides: Partial<PendingCritique> = {}): PendingCritique {
  return {
    critique_id: "c-1",
    session_id: "s1",
    created_sha: "sha0",
    created_at: "2026-07-21T00:00:00Z",
    hooks_elapsed: 0,
    status: "pending",
    severity: "medium",
    finding_text: "fix line 3",
    anchors: [{ file: "foo.ts", line: 3, tool: "git-diff", fingerprint: lineContentFingerprint(FILE, 3) }],
    distil_attempts: 0,
    ...overrides,
  };
}

function readLog(stateBase: string): AdjudicationRecord[] {
  const p = adjudicationLogPath(stateBase);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function sweep(
  dir: string,
  entries: PendingCritique[],
  deps: Parameters<typeof sweepEntriesOnce>[3] = {},
): Promise<AdjudicationRecord[]> {
  const stateBase = join(dir, ".siltpoke");
  await writePending(pendingQueuePath(stateBase), entries);
  await sweepEntriesOnce(join(dir, "home"), stateBase, join(dir, "proj"), {
    now: () => new Date("2026-07-21T01:00:00Z"),
    ...deps,
  });
  return readLog(stateBase);
}

test("one adjudication produces exactly one record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-"));
  try {
    const rows = await sweep(dir, [pending()], {
      oracleFn: async () => "not_yet",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].critique_id).toBe("c-1");
    expect(rows[0].verdict).toBe("not_yet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the record carries the tier and, on abstain, the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-tier-"));
  try {
    // Real oracle (no oracleFn override) against an unreadable file: the point
    // is that the reason survives the trip from the oracle into the log rather
    // than being flattened back to a bare "abstain" at the boundary.
    const rows = await sweep(dir, [pending({ created_sha: null })]);
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe("abstain");
    expect(rows[0].abstain_reason).toBe("no_baseline_sha");
    expect(rows[0].verdict_tier).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an acted verdict records what the writer actually did", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-write-"));
  try {
    for (const outcome of ["appended", "bumped", "garbage", "dup"] as const) {
      const sub = mkdtempSync(join(tmpdir(), `siltpoke-adj-${outcome}-`));
      try {
        const rows = await sweep(sub, [pending()], {
          oracleFn: async () => "acted",
          writeFn: async () => ({ written: outcome }),
        });
        expect(rows.length).toBe(1);
        expect(rows[0].verdict).toBe("acted");
        expect(rows[0].write_outcome).toBe(outcome);
      } finally {
        rmSync(sub, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TTL drop is recorded, not silently swallowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-ttl-"));
  try {
    // Old enough that the TTL fires on this sweep.
    const rows = await sweep(dir, [pending({ created_at: "2026-01-01T00:00:00Z" })], {
      oracleFn: async () => "not_yet",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].write_outcome).toBe("ttl_drop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer that throws is recorded as a write failure, not as a successful append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-fail-"));
  try {
    const rows = await sweep(dir, [pending()], {
      oracleFn: async () => "acted",
      writeFn: async () => { throw new Error("disk full"); },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe("acted");
    expect(rows[0].write_outcome).toBe("write_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latency is measured from enqueue to adjudication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-latency-"));
  try {
    // created_at 00:00Z, `now` stubbed to 01:00Z => exactly one hour.
    const rows = await sweep(dir, [pending()], { oracleFn: async () => "not_yet" });
    expect(rows[0].enqueued_at).toBe("2026-07-21T00:00:00Z");
    expect(rows[0].latency_ms).toBe(3_600_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every entry in a mixed queue gets its own record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-multi-"));
  try {
    const verdicts: Record<string, "acted" | "not_yet" | "abstain"> = {
      "c-a": "acted",
      "c-b": "not_yet",
      "c-c": "abstain",
    };
    const rows = await sweep(
      dir,
      [pending({ critique_id: "c-a" }), pending({ critique_id: "c-b" }), pending({ critique_id: "c-c" })],
      {
        oracleFn: async (e) => verdicts[e.critique_id],
        writeFn: async () => ({ written: "appended" }),
      },
    );
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.critique_id).sort()).toEqual(["c-a", "c-b", "c-c"]);
    // acted_rate is 1/3 here — computable, which it was not before.
    expect(rows.filter((r) => r.verdict === "acted").length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logging never breaks the sweep", async () => {
  // The log is telemetry. If it cannot be written, the memory loop must still
  // run — the same fail-soft discipline appendJsonLine uses on the hook side.
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-failsoft-"));
  try {
    const stateBase = join(dir, ".siltpoke");
    await writePending(pendingQueuePath(stateBase), [pending()]);
    const res = await sweepEntriesOnce(join(dir, "home"), stateBase, join(dir, "proj"), {
      now: () => new Date("2026-07-21T01:00:00Z"),
      oracleFn: async () => "not_yet",
      appendAdjudicationFn: async () => { throw new Error("log unwritable"); },
    });
    expect(res.pending).toBe(1); // the sweep completed normally
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a surviving entry is not labelled with a write outcome", async () => {
  // A reviewer pass found that changing the survivor branch's bare `log()` to
  // `log("dup")` passed the entire suite. Nothing was written for a `not_yet` —
  // labelling it would permanently misfile every surviving critique as a
  // dup/garbage write attempt, corrupting the exact garbage/dup rate this log
  // exists to make computable. The absence of the field is load-bearing, so it
  // gets its own assertion.
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-survivor-"));
  try {
    const rows = await sweep(dir, [pending()], { oracleFn: async () => "not_yet" });
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe("not_yet");
    expect(rows[0].write_outcome).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an abstain is not labelled with a write outcome either", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-adj-abstain-nowrite-"));
  try {
    const rows = await sweep(dir, [pending({ created_sha: null })]);
    expect(rows[0].verdict).toBe("abstain");
    expect(rows[0].write_outcome).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
