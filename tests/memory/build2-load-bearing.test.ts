// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePositiveRule } from "../../src/memory/positive-writer";
import { readMemory } from "../../src/memory/memory";
import { selectRelevantRules } from "../../src/brain/rule-selector";
import {
  enqueuePending,
  readPending,
  pendingQueuePath,
  type PendingCritique,
} from "../../src/memory/pending-queue";
import { sweepEntriesOnce } from "../../src/memory/distil-worker";

test("an auto-written acted_on rule reaches the store AND is selected for a matching file type", async () => {
  const home = await mkdtemp(join(tmpdir(), "lb-"));
  const entry: PendingCritique = {
    critique_id: "c-lb",
    session_id: "s",
    created_sha: "sha",
    created_at: "2026-07-15T00:00:00Z",
    hooks_elapsed: 0,
    status: "acted",
    severity: "medium",
    finding_text: "guard user before .email",
    anchors: [{ file: "u.ts", line: 3, tool: "tsc", fingerprint: "fp" }],
    distil_attempts: 0,
  };

  await writePositiveRule(home, entry, {
    reflectionFn: async () => ({
      output: {
        reflection: "r",
        learned_rule: "Always null-check user before accessing .email",
        rule_category: "null-safety",
        confidence: "medium",
        applies_to_file_types: ["ts"],
      },
      usage: {} as any,
    }),
    newRuleId: () => "lr-lb",
  });

  const mem = await readMemory(home);
  const selected = selectRelevantRules(mem!.learned_rules, new Set(["ts"]), 15);
  expect(selected.some((r) => r.id === "lr-lb")).toBe(true); // wired into the READ path
});

test("enqueue -> sweepEntriesOnce (oracle=acted) -> real writePositiveRule -> store -> selector, entry dropped from queue", async () => {
  const base = await mkdtemp(join(tmpdir(), "lb-sweep-"));
  const homeBase = base;
  const stateBase = base;
  const cwd = base;

  const queuePath = pendingQueuePath(stateBase);
  const entry: PendingCritique = {
    critique_id: "c-sweep",
    session_id: "s",
    created_sha: "sha",
    created_at: "2026-07-15T00:00:00Z",
    hooks_elapsed: 0,
    status: "pending",
    severity: "medium",
    finding_text: "missing await on async db call",
    anchors: [{ file: "svc.ts", line: 10, tool: "tsc", fingerprint: "fp2" }],
    distil_attempts: 0,
  };
  await enqueuePending(queuePath, entry);

  const result = await sweepEntriesOnce(homeBase, stateBase, cwd, {
    oracleFn: async () => "acted",
    writeFn: (h, e) =>
      writePositiveRule(h, e, {
        reflectionFn: async () => ({
          output: {
            reflection: "r",
            learned_rule: "Always await async db calls before returning",
            rule_category: "async-safety",
            confidence: "medium",
            applies_to_file_types: ["ts"],
          },
          usage: {} as any,
        }),
        newRuleId: () => "lr-sweep",
      }),
  });

  expect(result.written).toBe(1);

  const remaining = await readPending(queuePath);
  expect(remaining).toHaveLength(0);

  const mem = await readMemory(homeBase);
  const rule = mem!.learned_rules.find((r) => r.id === "lr-sweep");
  expect(rule).toBeDefined();
  expect(rule!.origin).toBe("acted_on");

  const selected = selectRelevantRules(mem!.learned_rules, new Set(["ts"]), 15);
  expect(selected.some((r) => r.id === "lr-sweep")).toBe(true);
});
