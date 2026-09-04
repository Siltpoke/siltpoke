// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { randomBytes } from "node:crypto";
import {
  appendLearnedRule, readMemory, writeMemory, emptyMemory, type LearnedRule,
} from "./memory";
import type { PendingCritique } from "./pending-queue";
import { callReflection as defaultCallReflection } from "../brain/reflection";

export const ACTED_ON_SEED =
  "The user or agent ACTED ON this critique (fixed the flagged code), mechanically confirmed by git. " +
  "Distil the single generalizable rule this validated catch embodies, so the critic keeps making it.";

type ReflectionFn = typeof defaultCallReflection;

export interface WritePositiveDeps {
  reflectionFn?: ReflectionFn;
  newRuleId?: () => string;
  now?: () => Date;
}

export interface WritePositiveResult {
  written: "appended" | "bumped" | "garbage" | "dup";
  rule_id?: string;
  /**
   * The rule's text + category as they exist in the store after this call —
   * the distilled output on `appended`, the PRE-EXISTING rule's own fields on
   * `bumped`. Present so a caller can freeze the rule's content instead of
   * keeping only an id that has to be re-resolved against a `memory.json` that
   * may have churned since (case1 forward-capture's `provenance-private.json`).
   * Absent on `dup`/`garbage`: no rule was written by this call and the
   * pre-existing one's content is not in hand here.
   */
  rule_text?: string;
  rule_category?: string;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Build-2 positive writer — the ONLY place an LLM enters Build 2, and only
 * AFTER the zero-LLM oracle (Task 4) already confirmed a critique was acted
 * on. Distils `entry.finding_text` into a general `LearnedRule` via
 * `callReflection` (D6-b), tagged `origin:"acted_on"`. If a rule with the
 * same normalized category already exists, reinforces it (bumps
 * `applied_count`, AC4) instead of appending a near-duplicate — otherwise
 * funnels through `appendLearnedRule` (garbage + exact-dup filters already
 * live there).
 */
export async function writePositiveRule(
  homeBase: string, entry: PendingCritique, deps: WritePositiveDeps = {},
): Promise<WritePositiveResult> {
  const reflectionFn = deps.reflectionFn ?? defaultCallReflection;
  const newRuleId = deps.newRuleId ?? (() => "lr-" + randomBytes(2).toString("hex"));
  const now = deps.now ?? (() => new Date());

  const { output } = await reflectionFn({ critiqueBody: entry.finding_text, userReason: ACTED_ON_SEED, mode: "acted_on" });

  const rule: LearnedRule = {
    id: newRuleId(),
    rule: output.learned_rule,
    category: output.rule_category,
    created_at: now().toISOString(),
    applied_count: 0,
    effectiveness: "good",
    confidence: output.confidence,
    applies_to_file_types: output.applies_to_file_types,
    source: `acted-on critique ${entry.critique_id}`,
    origin: "acted_on",
  };

  // category-match bump (AC4) — shares the dedup responsibility with appendLearnedRule
  const existing = (await readMemory(homeBase)) ?? emptyMemory();
  const match = existing.learned_rules.find((r) => normalize(r.category) === normalize(rule.category));
  if (match) {
    const bumped = existing.learned_rules.map((r) =>
      r.id === match.id ? { ...r, applied_count: r.applied_count + 1, last_triggered_at: now().toISOString() } : r);
    await writeMemory(homeBase, { ...existing, learned_rules: bumped });
    // the rule that actually lives in the store is `match`, not this call's
    // distil output — report ITS text/category.
    return { written: "bumped", rule_id: match.id, rule_text: match.rule, rule_category: match.category };
  }

  const res = await appendLearnedRule(homeBase, rule);
  if (res.appended) {
    return { written: "appended", rule_id: res.rule_id, rule_text: rule.rule, rule_category: rule.category };
  }
  return { written: res.reason === "garbage" ? "garbage" : "dup", rule_id: res.rule_id };
}
