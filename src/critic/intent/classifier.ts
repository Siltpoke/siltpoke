// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { INTENT_RULES, type IntentClassification, type IntentSignal } from "./regex-rules";

export interface IntentInput {
  user_message: string;
  commit_msg: string | null;
  changed_file_exts: Set<string>;
}

export interface IntentResult {
  classification: IntentClassification;
  confidence: number;
  signals: IntentSignal[];
  signal_source: "regex" | "brain-fallback";
}

export function classifyIntent(input: IntentInput): IntentResult {
  const signals: IntentSignal[] = [];
  // Score by classification: sum confidences of matched rules
  const scores = new Map<IntentClassification, number>();

  for (const rule of INTENT_RULES) {
    const inUser = (rule.applies_to === "user_message" || rule.applies_to === "both") && rule.pattern.test(input.user_message);
    const inCommit = (rule.applies_to === "commit_msg" || rule.applies_to === "both") && input.commit_msg !== null && rule.pattern.test(input.commit_msg);
    if (inUser) {
      signals.push({ source: "user_message", matched_rule_id: rule.id, confidence: rule.confidence });
      scores.set(rule.classification, (scores.get(rule.classification) ?? 0) + rule.confidence);
    }
    if (inCommit) {
      signals.push({ source: "commit_msg", matched_rule_id: rule.id, confidence: rule.confidence });
      scores.set(rule.classification, (scores.get(rule.classification) ?? 0) + rule.confidence);
    }
  }

  // File extension heuristic: only test/docs files touched → chore signal
  const onlyTestDocs = input.changed_file_exts.size > 0 &&
    [...input.changed_file_exts].every(ext => ["md", "test.ts", "test.tsx", "spec.ts"].includes(ext));
  if (onlyTestDocs) {
    signals.push({ source: "file_extensions", matched_rule_id: "ext-only-test-docs", confidence: 0.6 });
    scores.set("chore", (scores.get("chore") ?? 0) + 0.6);
  }

  if (scores.size === 0) {
    return { classification: "exploration", confidence: 0.3, signals: [], signal_source: "regex" };
  }

  // Pick winner
  let winner: IntentClassification = "exploration";
  let winnerScore = 0;
  for (const [k, v] of scores) {
    if (v > winnerScore) { winner = k; winnerScore = v; }
  }
  // Normalize: cap at 0.99; we never claim 1.0 from regex alone
  const confidence = Math.min(0.99, winnerScore / 1.5);
  return { classification: winner, confidence, signals, signal_source: "regex" };
}
