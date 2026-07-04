// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { RubricInput, RubricRule, RubricRuleResult, RubricTrigger } from "./types";

export interface RubricEngineResult {
  triggers: RubricTrigger[];
  rule_results: RubricRuleResult[];
  errors: Array<{ rule_id: string; error: string }>;
  total_duration_ms: number;
}

function fileExt(path: string): string {
  const m = path.match(/\.([^./]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function ruleApplies(rule: RubricRule, files: string[]): boolean {
  if (rule.languages.includes("*")) return true;
  return files.some(f => rule.languages.includes(fileExt(f) as never));
}

export async function runRubric(
  input: RubricInput,
  rules: ReadonlyArray<RubricRule>,
): Promise<RubricEngineResult> {
  const t0 = performance.now();
  const applicable = rules.filter(r => ruleApplies(r, input.changedFiles));
  const settled = await Promise.allSettled(applicable.map(r => r.run(input)));
  const triggers: RubricTrigger[] = [];
  const rule_results: RubricRuleResult[] = [];
  const errors: Array<{ rule_id: string; error: string }> = [];

  for (let i = 0; i < applicable.length; i++) {
    const rule = applicable[i];
    const s = settled[i];
    if (s.status === "fulfilled") {
      rule_results.push(s.value);
      triggers.push(...s.value.triggers);
    } else {
      errors.push({ rule_id: rule.id, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
    }
  }

  return { triggers, rule_results, errors, total_duration_ms: performance.now() - t0 };
}
