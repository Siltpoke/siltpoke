// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export type RubricTier = 1 | 2 | 3;
export type RubricSeverity = "low" | "med" | "high";

export interface RubricTrigger {
  rule_id: string;
  tier: RubricTier;
  severity: RubricSeverity;
  file: string;
  line: number;
  end_line?: number;
  snippet: string;
  /**
   * True only when `snippet` is bytes read out of `file`. Absent or false means
   * the rule SYNTHESIZED it — `test-gap` emits `+45 lines added to src/foo.ts`,
   * which is siltpoke's own accounting sentence wearing a snippet's clothes.
   *
   * Only a source snippet may be offered to the reviewer as citable evidence:
   * the evidence check exists to ask whether a tool really said this, and a
   * synthesized line would pass it while being no more a quote of the code than
   * `message` is. Absent means NOT source, so a rule added later is uncitable
   * until its author says otherwise — the safe direction for a guard input.
   */
  snippet_is_source?: boolean;
  message: string;
  suggested_fix?: string;
}

export interface RubricRuleResult {
  rule_id: string;
  triggers: RubricTrigger[];
  duration_ms: number;
  error?: string;
}

export interface RubricInput {
  cwd: string;
  changedFiles: string[];
  diffHunks: Array<{ file: string; addedLines: number[] }>;
}

export interface RubricRule {
  id: string;
  tier: RubricTier;
  languages: ReadonlyArray<"ts" | "tsx" | "js" | "jsx" | "py" | "*">;
  run(input: RubricInput): Promise<RubricRuleResult>;
}
