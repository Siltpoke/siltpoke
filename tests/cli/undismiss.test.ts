/**
 * Tests for src/cli/undismiss.ts.
 *
 * Strategy: tmpdir sandbox with both homeBase + projectBase. Seed
 * critique files + memory.json + feedback-archive.jsonl manually.
 * Cover not_found / already-pending / happy paths / shared-rule /
 * legacy-fallback / no-rule / output formats.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runUndismiss,
  formatUndismissHuman,
  formatUndismissJson,
  type UndismissResult,
} from "../../src/cli/undismiss";
import { readMemory, writeMemory, emptyMemory, type LearnedRule } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";
import {
  appendFeedbackArchive,
  type FeedbackArchiveEntry,
} from "../../src/memory/feedback-archive";

let tmpHome: string;
let projectCwd: string;
let homeBase: string;
let projectBase: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-undismiss-"));
  homeBase = join(tmpHome, ".siltpoke");
  projectCwd = join(tmpHome, "proj");
  projectBase = join(projectCwd, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
  mkdirSync(projectBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const critiqueTpl = `---
schemaVersion: 1
critique_id: __ID__
status: __STATUS__
---

# [SILTPOKE CRITIQUE]
queries.py:47 missing null check on profiles.bio
`;

function seedCritique(id: string, status: "pending" | "dismissed" = "dismissed"): string {
  const date = "2026-05-14";
  const dir = join(projectBase, "critiques", "archive", date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(
    path,
    critiqueTpl.replace("__ID__", id).replace("__STATUS__", status),
  );
  return path;
}

function seedRule(id: string, text: string, category: string): LearnedRule {
  return {
    id,
    rule: text,
    category,
    created_at: "2026-05-14T12:00:00Z",
    applied_count: 0,
    effectiveness: "good",
  };
}

// Rules are appended by dismiss (Task 4) to the canonical V3 store at
// homeBase — never at projectBase. Undismiss's rollback must remove from the
// same base, so tests seed the rule where production actually writes it:
// flip homeBase to V3 (global.json present) then writeMemory targets the
// per-project slice, keyed internally on resolveProjectRoot(process.cwd()).
async function seedMemoryWithRules(rules: LearnedRule[]): Promise<void> {
  await writeGlobal(homeBase, emptyGlobal());
  const mem = emptyMemory();
  mem.learned_rules = rules;
  await writeMemory(homeBase, mem);
}

async function seedDismissalEntry(
  critique_id: string,
  rule_id: string | null,
  opts: { rule_created?: boolean; ts?: string } = {},
): Promise<void> {
  const entry: FeedbackArchiveEntry = {
    ts: opts.ts ?? "2026-05-14T12:00:05Z",
    critique_id,
    verdict: "dismissed",
    reason: "false positive",
    reflection: {
      rule_id,
      rule_category: rule_id ? "null_check" : null,
      confidence: rule_id ? "high" : null,
      ...(opts.rule_created !== undefined ? { rule_created: opts.rule_created } : {}),
    },
  };
  await appendFeedbackArchive(homeBase, entry);
}

const NOW = new Date("2026-05-14T13:00:00Z");

// ── core behavior ──────────────────────────────────────────────────────────

describe("runUndismiss — status flips", () => {
  test("critique not found → status_set: 'not_found', no mutations", async () => {
    const r = await runUndismiss({
      critiqueId: "c-nope",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.undismissed).toBe(false);
    expect(r.status_set).toBe("not_found");
    expect(r.was_status).toBeNull();
  });

  test("already-pending critique → idempotent no-op (status_set: 'wasnt_dismissed')", async () => {
    seedCritique("c-already", "pending");
    const r = await runUndismiss({
      critiqueId: "c-already",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.undismissed).toBe(false);
    expect(r.status_set).toBe("wasnt_dismissed");
    expect(r.was_status).toBe("pending");
    expect(r.rule_removed).toBe(false);
  });

  test("dismissed critique → status flipped to pending", async () => {
    const path = seedCritique("c-flip", "dismissed");
    const r = await runUndismiss({
      critiqueId: "c-flip",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.undismissed).toBe(true);
    expect(r.status_set).toBe("pending");
    expect(r.was_status).toBe("dismissed");
    expect(readFileSync(path, "utf8")).toContain("status: pending");
  });
});

// ── rule removal logic ─────────────────────────────────────────────────────

describe("runUndismiss — rule removal", () => {
  test("rule_created: true → rule is removed from memory.json", async () => {
    seedCritique("c-with-rule", "dismissed");
    await seedMemoryWithRules([seedRule("lr-aa", "no nulls", "null_check")]);
    await seedDismissalEntry("c-with-rule", "lr-aa", { rule_created: true });

    const r = await runUndismiss({
      critiqueId: "c-with-rule",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.rule_removed).toBe(true);
    expect(r.rule_id).toBe("lr-aa");
    expect(r.rule_kept_reason).toBeNull();

    // Verify the V3 store (homeBase) now has 0 rules — not projectBase.
    const mem = await readMemory(homeBase);
    expect(mem?.learned_rules).toHaveLength(0);
  });

  test("rule_created: false (shared) → rule is kept, reason='shared'", async () => {
    seedCritique("c-shared", "dismissed");
    await seedMemoryWithRules([seedRule("lr-bb", "no nulls", "null_check")]);
    await seedDismissalEntry("c-shared", "lr-bb", { rule_created: false });

    const r = await runUndismiss({
      critiqueId: "c-shared",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.rule_removed).toBe(false);
    expect(r.rule_id).toBe("lr-bb");
    expect(r.rule_kept_reason).toBe("shared");

    const mem = await readMemory(homeBase);
    expect(mem?.learned_rules).toHaveLength(1);
  });

  test("legacy entry (no rule_created) — sole user of rule → safe to remove", async () => {
    seedCritique("c-legacy-sole", "dismissed");
    await seedMemoryWithRules([seedRule("lr-cc", "no nulls", "null_check")]);
    // Legacy entry: no rule_created field set.
    await seedDismissalEntry("c-legacy-sole", "lr-cc", {});

    const r = await runUndismiss({
      critiqueId: "c-legacy-sole",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.rule_removed).toBe(true);
    expect(r.rule_kept_reason).toBeNull();
  });

  test("legacy entry (no rule_created) — earlier dismissal used same rule → keep", async () => {
    seedCritique("c-legacy-shared", "dismissed");
    await seedMemoryWithRules([seedRule("lr-dd", "no nulls", "null_check")]);
    // Plant an EARLIER dismissal entry referencing the same rule.
    await seedDismissalEntry("c-other-earlier", "lr-dd", { ts: "2026-05-14T11:00:00Z" });
    // Now plant the current critique's dismissal (later).
    await seedDismissalEntry("c-legacy-shared", "lr-dd", { ts: "2026-05-14T12:00:05Z" });

    const r = await runUndismiss({
      critiqueId: "c-legacy-shared",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.rule_removed).toBe(false);
    expect(r.rule_kept_reason).toBe("legacy_shared");
  });

  test("no rule in dismissal (low confidence path) → just flip status", async () => {
    seedCritique("c-norule", "dismissed");
    // Dismissal entry has reflection but rule_id is null.
    await seedDismissalEntry("c-norule", null);

    const r = await runUndismiss({
      critiqueId: "c-norule",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.undismissed).toBe(true);
    expect(r.status_set).toBe("pending");
    expect(r.rule_id).toBeNull();
    expect(r.rule_removed).toBe(false);
  });

  test("no dismissal entry in archive at all → status flips, no rule lookup", async () => {
    seedCritique("c-no-archive", "dismissed");
    const r = await runUndismiss({
      critiqueId: "c-no-archive",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });
    expect(r.undismissed).toBe(true);
    expect(r.rule_id).toBeNull();
    expect(r.rule_removed).toBe(false);
  });
});

// ── audit trail ────────────────────────────────────────────────────────────

describe("runUndismiss — audit trail", () => {
  test("appends 'undismissed' entry to feedback archive with reverses_critique_id", async () => {
    seedCritique("c-audit", "dismissed");
    await seedDismissalEntry("c-audit", null);

    await runUndismiss({
      critiqueId: "c-audit",
      cwd: projectCwd,
      homeBase,
      projectBase,
      now: () => NOW,
    });

    const archive = readFileSync(join(homeBase, "feedback-archive.jsonl"), "utf8");
    const lines = archive.trim().split("\n").map((l) => JSON.parse(l));
    const undismissEntry = lines.find((e) => e.verdict === "undismissed");
    expect(undismissEntry).toBeTruthy();
    expect(undismissEntry.critique_id).toBe("c-audit");
    expect(undismissEntry.reverses_critique_id).toBe("c-audit");
    expect(undismissEntry.ts).toBe(NOW.toISOString());
  });
});

// ── formatters ─────────────────────────────────────────────────────────────

describe("formatters", () => {
  test("human says 'restored' on happy path with rule removed", () => {
    const out = formatUndismissHuman({
      undismissed: true,
      critique_id: "c-x",
      status_set: "pending",
      was_status: "dismissed",
      rule_removed: true,
      rule_id: "lr-1",
      rule_kept_reason: null,
    });
    expect(out).toContain("restored");
    expect(out).toContain("dismissed → pending");
    expect(out).toContain("Learned rule lr-1 removed");
  });

  test("human says 'kept' with shared reason", () => {
    const out = formatUndismissHuman({
      undismissed: true,
      critique_id: "c-x",
      status_set: "pending",
      was_status: "dismissed",
      rule_removed: false,
      rule_id: "lr-1",
      rule_kept_reason: "shared",
    });
    expect(out).toContain("kept");
    expect(out).toContain("other dismissals");
  });

  test("human says 'no learned rule' when rule_id is null", () => {
    const out = formatUndismissHuman({
      undismissed: true,
      critique_id: "c-x",
      status_set: "pending",
      was_status: "dismissed",
      rule_removed: false,
      rule_id: null,
      rule_kept_reason: null,
    });
    expect(out).toContain("restored");
    expect(out).toContain("No learned rule was created");
  });

  test("human says 'not found' for not_found path", () => {
    const out = formatUndismissHuman({
      undismissed: false,
      critique_id: "c-x",
      status_set: "not_found",
      was_status: null,
      rule_removed: false,
      rule_id: null,
      rule_kept_reason: null,
    });
    expect(out).toContain("not found");
  });

  test("human says 'wasn't dismissed' for idempotent path", () => {
    const out = formatUndismissHuman({
      undismissed: false,
      critique_id: "c-x",
      status_set: "wasnt_dismissed",
      was_status: "pending",
      rule_removed: false,
      rule_id: null,
      rule_kept_reason: null,
    });
    expect(out).toContain("wasn't dismissed");
  });

  test("json emits structured output", () => {
    const result: UndismissResult = {
      undismissed: true,
      critique_id: "c-x",
      status_set: "pending",
      was_status: "dismissed",
      rule_removed: true,
      rule_id: "lr-1",
      rule_kept_reason: null,
    };
    const parsed = JSON.parse(formatUndismissJson(result));
    expect(parsed.undismissed).toBe(true);
    expect(parsed.rule_removed).toBe(true);
    expect(parsed.rule_id).toBe("lr-1");
  });
});
