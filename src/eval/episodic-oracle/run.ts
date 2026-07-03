// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { OracleAggregate, OracleScore } from "./score";
import { aggregateScores, scoreFixture } from "./score";
import type { OracleFixture, RetrievePolicy } from "./types";

export interface OracleRun {
  scores: OracleScore[];
  aggregate: OracleAggregate;
}

export function runOracle(
  fixtures: OracleFixture[],
  policy: RetrievePolicy,
): OracleRun {
  const pairs = fixtures.map((fixture) => ({
    fixture,
    decision: policy(fixture.scenario, fixture.store),
  }));
  const scores = pairs.map(({ fixture, decision }) => scoreFixture(fixture, decision));
  return { scores, aggregate: aggregateScores(pairs) };
}

export function formatOracleReport(run: OracleRun): string {
  const a = run.aggregate;
  const lines: string[] = ["=== Episodic Eval Oracle ==="];
  if (!a.must_not_regress_pass) {
    lines.push("!!! FAIL — wrong-injection on must-not-regress subset !!!");
  }
  lines.push(`wrong-injection-rate: ${(a.wrong_injection_rate * 100).toFixed(1)}%  (target 0)`);
  lines.push(`inject precision/recall: ${a.inject_precision.toFixed(2)} / ${a.inject_recall.toFixed(2)}`);
  lines.push(`abstain-correctness: ${a.abstain_correctness.toFixed(2)}`);
  lines.push(`must-not-regress: ${a.must_not_regress_pass ? "PASS" : "FAIL"}`);
  lines.push(`fixtures: ${a.passed}/${a.total} passed`);
  lines.push("");
  for (const s of run.scores) {
    lines.push(`  [${s.passed ? "PASS" : "FAIL"}] ${s.fixture_id} (${s.kind})`);
    for (const f of s.failures) lines.push(`         - ${f}`);
  }
  return lines.join("\n");
}
