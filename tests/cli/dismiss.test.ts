import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDismiss } from "../../src/cli/dismiss";
import type { ReflectionCallResult } from "../../src/brain/reflection";
import { readMemory } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";

let tmpHome: string;
let projectCwd: string;
let homeBase: string;
// Per-test preference-log path so handler writes never touch the user's real
// ~/.siltpoke/preference-log.jsonl (the bug these tests previously caused).
let prefLog: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-dismiss-"));
  homeBase = join(tmpHome, ".siltpoke");
  projectCwd = join(tmpHome, "proj");
  prefLog = join(homeBase, "preference-log.jsonl");
  mkdirSync(homeBase, { recursive: true });
  mkdirSync(projectCwd, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const critiqueMd = `---
schemaVersion: 1
critique_id: c-a7b3
status: pending
---

# [SILTPOKE CRITIQUE]
queries.py:47 missing null check on profiles.bio
`;

function seedCritique(id: string, status: "pending" | "dismissed" = "pending"): string {
  // Critiques are per-project — seed under {projectCwd}/.siltpoke/critiques/,
  // matching where on-stop.ts now writes them.
  const date = "2026-05-14";
  const dir = join(projectCwd, ".siltpoke", "critiques", "archive", date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(path, critiqueMd.replace("c-a7b3", id).replace("status: pending", `status: ${status}`));
  return path;
}

function fakeReflection(
  output: Partial<ReflectionCallResult["output"]> & {
    confidence: "high" | "medium" | "low";
  },
  usage: Partial<ReflectionCallResult["usage"]> = {},
): (
  opts: unknown,
) => Promise<ReflectionCallResult> {
  return async () => ({
    output: {
      reflection: output.reflection ?? "I was wrong about null handling.",
      learned_rule:
        output.learned_rule ??
        "Before flagging NULL handling, grep for existing null checks.",
      rule_category: output.rule_category ?? "null_check",
      confidence: output.confidence,
      applies_to_file_types: output.applies_to_file_types ?? ["py"],
    },
    usage: {
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 200,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      input_tokens: usage.input_tokens ?? 30,
      output_tokens: usage.output_tokens ?? 60,
      total_cost_usd: usage.total_cost_usd ?? 0.0002,
    },
  });
}

test("not_found: returns early with status_set: not_found", async () => {
  const result = await runDismiss({
    critiqueId: "c-nope",
    reason: "doesn't matter",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fakeReflection({ confidence: "high" }),
  });
  expect(result.status_set).toBe("not_found");
  expect(result.recent_appended).toBe(false);
  expect(result.archive_appended).toBe(false);
});

test("happy path: status flips + recent + archive + rule appended", async () => {
  seedCritique("c-a7b3");
  const result = await runDismiss({
    critiqueId: "c-a7b3",
    reason: "already null-checked at line 30",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fakeReflection({ confidence: "high" }),
  });
  expect(result.status_set).toBe("dismissed");
  expect(result.recent_appended).toBe(true);
  expect(result.archive_appended).toBe(true);
  expect(result.reflection.ran).toBe(true);
  expect(result.reflection.rule_appended).toBe(true);
  expect(result.reflection.rule_category).toBe("null_check");

  // critique status flipped — critique file lives per-project now.
  const md = readFileSync(
    join(projectCwd, ".siltpoke", "critiques", "archive", "2026-05-14", "c-a7b3.md"),
    "utf8",
  );
  expect(md).toContain("status: dismissed");

  // recent_feedback under project cwd
  const recent = readFileSync(
    join(projectCwd, ".siltpoke", "recent_feedback.jsonl"),
    "utf8",
  );
  expect(recent).toContain("c-a7b3");
  expect(recent).toContain("dismissed");

  // archive line under homeBase
  const archive = readFileSync(
    join(homeBase, "feedback-archive.jsonl"),
    "utf8",
  );
  expect(archive).toContain("c-a7b3");

  // memory.json has new rule — rules now live under the canonical homeBase
  // (V3) store, not the per-project legacy base.
  const mem = JSON.parse(readFileSync(join(homeBase, "memory.json"), "utf8"));
  expect(mem.learned_rules).toHaveLength(1);
  expect(mem.learned_rules[0].category).toBe("null_check");
  expect(mem.learned_rules[0].source).toContain("c-a7b3");
  expect(mem.learned_rules[0].source).toContain(
    "I was wrong about null handling.",
  );

  // brain-calls.jsonl log with kind: reflection
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"kind":"reflection"');
});

test("low_confidence: rule NOT appended, recent + archive still written", async () => {
  seedCritique("c-low");
  const result = await runDismiss({
    critiqueId: "c-low",
    reason: "maybe wrong",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fakeReflection({ confidence: "medium" }),
  });
  expect(result.reflection.ran).toBe(true);
  expect(result.reflection.rule_appended).toBe(false);
  expect(result.reflection.skip_reason).toBe("low_confidence");
  expect(result.recent_appended).toBe(true);
  expect(result.archive_appended).toBe(true);
  expect(existsSync(join(projectCwd, ".siltpoke", "memory.json"))).toBe(false);
});

test("duplicate rule: second dismiss does not double-append", async () => {
  seedCritique("c-first");
  seedCritique("c-second");
  const fn = fakeReflection({ confidence: "high" });

  await runDismiss({
    critiqueId: "c-first",
    reason: "first reason",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fn,
  });
  const second = await runDismiss({
    critiqueId: "c-second",
    reason: "second reason different prose",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fn,
  });

  expect(second.reflection.ran).toBe(true);
  expect(second.reflection.rule_appended).toBe(false);
  expect(second.reflection.skip_reason).toBe("duplicate");

  const mem = JSON.parse(readFileSync(join(homeBase, "memory.json"), "utf8"));
  expect(mem.learned_rules).toHaveLength(1);
});

test("no reason: reflection skipped, recent + archive still written", async () => {
  seedCritique("c-noreason");
  const result = await runDismiss({
    critiqueId: "c-noreason",
    reason: null,
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fakeReflection({ confidence: "high" }),
  });
  expect(result.reflection.ran).toBe(false);
  expect(result.reflection.skip_reason).toBe("no_reason");
  expect(result.recent_appended).toBe(true);
  expect(result.archive_appended).toBe(true);
  expect(existsSync(join(projectCwd, ".siltpoke", "memory.json"))).toBe(false);
});

test("reflection throws: caught and logged as error", async () => {
  seedCritique("c-err");
  const result = await runDismiss({
    critiqueId: "c-err",
    reason: "valid reason",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: async () => {
      throw new Error("rate limit");
    },
  });
  expect(result.reflection.ran).toBe(false);
  expect(result.reflection.skip_reason).toBe("error");
  expect(result.recent_appended).toBe(true);
  expect(result.archive_appended).toBe(true);
});

test("dismiss-with-reason writes a provenance-carrying rule to the V3 store", async () => {
  await writeGlobal(homeBase, emptyGlobal()); // flip homeBase to V3
  const critDir = join(homeBase, "critiques");
  mkdirSync(critDir, { recursive: true });
  writeFileSync(join(critDir, "latest.md"), "The critique body.\n");

  const result = await runDismiss({
    critiqueId: "latest",
    reason: "this was a rubric-noise false positive",
    cwd: projectCwd,
    homeBase,
    projectBase: homeBase, // route critique lookup through the V3 base for this test
    preferenceLogPath: prefLog,
    reflectionFn: async () => ({
      output: {
        reflection: "prefer evidence over rubric flags",
        learned_rule: "Downrank evidence-free rubric flags",
        rule_category: "critique-quality",
        confidence: "high",
        applies_to_file_types: [],
      },
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        total_cost_usd: 0,
      },
    }),
  });

  expect(result.reflection.rule_appended).toBe(true);
  const mem = await readMemory(homeBase);
  expect(mem?.learned_rules).toHaveLength(1);
  expect(mem?.learned_rules[0]?.source).toContain("latest");
  expect(mem?.learned_rules[0]?.source).toContain(
    "prefer evidence over rubric flags",
  );
});

test("already_dismissed critique still records recent + archive entries", async () => {
  seedCritique("c-twice", "dismissed");
  const result = await runDismiss({
    critiqueId: "c-twice",
    reason: "second click",
    cwd: projectCwd,
    homeBase,
    preferenceLogPath: prefLog,
    reflectionFn: fakeReflection({ confidence: "high" }),
  });
  expect(result.status_set).toBe("already_dismissed");
  expect(result.recent_appended).toBe(true);
  expect(result.archive_appended).toBe(true);
});
