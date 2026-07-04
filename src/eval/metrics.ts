// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { FixtureResult } from "./harness";

export interface PrecisionRecallResult {
  precision: number;
  recall: number;
  f1: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
}

/**
 * Compute precision / recall for trigger rule IDs.
 * `triggers` = rule IDs the system fired; `expected` = ground-truth rule IDs.
 */
export function precisionRecall(
  triggers: string[],
  expected: string[],
): PrecisionRecallResult {
  const triggerSet = new Set(triggers);
  const expectedSet = new Set(expected);

  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const t of triggerSet) {
    if (expectedSet.has(t)) tp++;
    else fp++;
  }
  for (const e of expectedSet) {
    if (!triggerSet.has(e)) fn++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
  };
}

export interface TokenRates {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
}

export interface SpanCost {
  span_id: string;
  cost_usd: number;
}

export interface Span {
  span_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
}

/**
 * Compute per-span and total cost from raw token counts + per-million-token rates.
 */
export function costFromSpans(
  spans: Span[],
  rates: TokenRates,
): { span_costs: SpanCost[]; total_usd: number } {
  const span_costs = spans.map((s) => {
    const input_cost = (s.input_tokens / 1_000_000) * rates.input_per_mtok;
    const output_cost = (s.output_tokens / 1_000_000) * rates.output_per_mtok;
    const cache_read_cost =
      ((s.cache_read_tokens ?? 0) / 1_000_000) * rates.cache_read_per_mtok;
    return {
      span_id: s.span_id,
      cost_usd: input_cost + output_cost + cache_read_cost,
    };
  });

  const total_usd = span_costs.reduce((sum, s) => sum + s.cost_usd, 0);
  return { span_costs, total_usd };
}

/**
 * Format a human-readable eval report from fixture results.
 */
export function formatReport(results: FixtureResult[]): string {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  const lines: string[] = [
    "=== Eval Report ===",
    `Total: ${total}  Passed: ${passed}  Failed: ${failed}`,
    "",
  ];

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${r.fixture_id}`);
    for (const f of r.failures) {
      lines.push(`         - ${f}`);
    }
  }

  lines.push("");
  const passRate = total === 0 ? 0 : Math.round((passed / total) * 100);
  lines.push(`Pass rate: ${passRate}%`);

  return lines.join("\n");
}
