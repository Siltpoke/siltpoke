// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePositiveRule } from "../../src/memory/positive-writer";
import { readMemory } from "../../src/memory/memory";
import type { PendingCritique } from "../../src/memory/pending-queue";

const entry: PendingCritique = {
  critique_id: "c-9", session_id: "s1", created_sha: "sha", created_at: "2026-07-15T00:00:00Z",
  hooks_elapsed: 0, status: "acted", severity: "medium",
  finding_text: "The null guard on the user object is missing before .email access.",
  anchors: [{ file: "u.ts", line: 42, tool: "tsc", fingerprint: "fp" }],
  distil_attempts: 0,
};
const stubReflect = (rule: string, category: string) => async () => ({
  output: { reflection: "user acted on it", learned_rule: rule, rule_category: category,
    confidence: "high" as const, applies_to_file_types: ["ts"] },
  usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } as any,
});

test("acted-on writes a new rule tagged origin=acted_on (AC1)", async () => {
  const home = await mkdtemp(join(tmpdir(), "pw-"));
  const r = await writePositiveRule(home, entry, {
    reflectionFn: stubReflect("Always null-check user before accessing .email", "null-safety"),
    newRuleId: () => "lr-new",
  });
  expect(r.written).toBe("appended");
  const mem = await readMemory(home);
  const rule = mem!.learned_rules.find((x) => x.id === "lr-new");
  expect(rule?.origin).toBe("acted_on");
});

test("appended result carries the distilled rule's text + category, not just its id", async () => {
  // The case1 forward-capture's private provenance record freezes the rule's
  // text/category so it stays readable after memory.json churns. The writer is
  // the only place that text exists at write time — an id-only return forced
  // the caller to write `text: ""`.
  const home = await mkdtemp(join(tmpdir(), "pw-"));
  const r = await writePositiveRule(home, entry, {
    reflectionFn: stubReflect("Always null-check user before accessing .email", "null-safety"),
    newRuleId: () => "lr-new",
  });
  expect(r).toEqual({
    written: "appended",
    rule_id: "lr-new",
    rule_text: "Always null-check user before accessing .email",
    rule_category: "null-safety",
  });
});

test("bumped result carries the MATCHED (pre-existing) rule's text + category", async () => {
  const home = await mkdtemp(join(tmpdir(), "pw-"));
  await writePositiveRule(home, entry, {
    reflectionFn: stubReflect("Always null-check user before .email", "null-safety"),
    newRuleId: () => "lr-1",
  });
  const r2 = await writePositiveRule(home, entry, {
    reflectionFn: stubReflect("Guard user before .email everywhere", "null-safety"),
    newRuleId: () => "lr-2",
  });
  expect(r2).toEqual({
    written: "bumped",
    rule_id: "lr-1",
    // the rule that actually lives in the store now — NOT this call's distil output
    rule_text: "Always null-check user before .email",
    rule_category: "null-safety",
  });
});

test("same-category acted-on bumps applied_count instead of appending (AC4)", async () => {
  const home = await mkdtemp(join(tmpdir(), "pw-"));
  await writePositiveRule(home, entry, { reflectionFn: stubReflect("Always null-check user before .email", "null-safety"), newRuleId: () => "lr-1" });
  const r2 = await writePositiveRule(home, entry, { reflectionFn: stubReflect("Guard user before .email everywhere", "null-safety"), newRuleId: () => "lr-2" });
  expect(r2.written).toBe("bumped");
  const mem = await readMemory(home);
  expect(mem!.learned_rules).toHaveLength(1);
  expect(mem!.learned_rules[0].applied_count).toBe(1);
});
