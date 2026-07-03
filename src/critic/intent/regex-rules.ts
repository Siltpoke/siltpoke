// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
export type IntentClassification =
  | "bugfix" | "refactor" | "feature" | "exploration" | "chore";

export interface IntentSignal {
  source: "user_message" | "commit_msg" | "file_extensions";
  matched_rule_id: string;
  confidence: number; // 0..1
}

export interface IntentRule {
  id: string;
  classification: IntentClassification;
  pattern: RegExp;
  confidence: number;
  applies_to: "user_message" | "commit_msg" | "both";
}

export const INTENT_RULES: ReadonlyArray<IntentRule> = [
  // bugfix
  { id: "bugfix-keyword-fix", classification: "bugfix", pattern: /\b(fix|fixes|fixed|fixing)\b/i, confidence: 0.85, applies_to: "both" },
  { id: "bugfix-keyword-bug", classification: "bugfix", pattern: /\b(bug|crash|broken|error|issue|bugfix)\b/i, confidence: 0.7, applies_to: "both" },
  { id: "bugfix-conv-commit", classification: "bugfix", pattern: /^fix(\(.+\))?:/i, confidence: 0.95, applies_to: "commit_msg" },
  // feature
  { id: "feature-keyword-add", classification: "feature", pattern: /\b(add|adds|added|adding|implement|implements)\b/i, confidence: 0.75, applies_to: "both" },
  { id: "feature-keyword-new", classification: "feature", pattern: /\b(new feature|introduce|introduces)\b/i, confidence: 0.8, applies_to: "both" },
  { id: "feature-conv-commit", classification: "feature", pattern: /^feat(\(.+\))?:/i, confidence: 0.95, applies_to: "commit_msg" },
  // refactor
  { id: "refactor-keyword", classification: "refactor", pattern: /\b(refactor(?:ing|ed|s)?|rename|extract|cleanup|reorganize|restructure|simplify)\b/i, confidence: 0.85, applies_to: "both" },
  { id: "refactor-conv-commit", classification: "refactor", pattern: /^refactor(\(.+\))?:/i, confidence: 0.95, applies_to: "commit_msg" },
  // chore
  { id: "chore-conv-commit", classification: "chore", pattern: /^(chore|docs|test|ci|build|perf)(\(.+\))?:/i, confidence: 0.95, applies_to: "commit_msg" },
  { id: "chore-keyword", classification: "chore", pattern: /\b(update deps|bump|dependencies|formatting|lint)\b/i, confidence: 0.75, applies_to: "both" },
  // exploration
  { id: "exploration-keyword", classification: "exploration", pattern: /\b(try|trying|experiment|explore|prototype|spike|wip)\b/i, confidence: 0.7, applies_to: "both" },
];
