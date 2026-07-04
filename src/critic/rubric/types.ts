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
