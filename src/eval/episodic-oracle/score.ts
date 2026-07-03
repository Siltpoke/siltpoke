// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { precisionRecall } from "../metrics";
import type { FixtureKind, OracleFixture, RetrievalDecision } from "./types";

export interface OracleScore {
  fixture_id: string;
  kind: FixtureKind;
  passed: boolean;
  failures: string[];
}

export interface OracleAggregate {
  wrong_injection_rate: number;
  inject_precision: number;
  inject_recall: number;
  abstain_correctness: number;
  must_not_regress_pass: boolean;
  total: number;
  passed: number;
}

export function scoreFixture(
  fixture: OracleFixture,
  decision: RetrievalDecision,
): OracleScore {
  const failures: string[] = [];
  const injected = new Set(decision.injected);

  for (const id of fixture.expect.must_inject) {
    if (!injected.has(id)) failures.push(`missed must_inject ${id}`);
  }
  for (const id of fixture.expect.must_not_inject) {
    if (injected.has(id)) failures.push(`wrong-injection ${id}`);
  }
  if (fixture.expect.must_abstain && !decision.abstained) {
    failures.push(`expected abstain, injected ${decision.injected.length}`);
  }
  if (decision.abstained && decision.injected.length > 0) {
    failures.push("abstained=true but injected non-empty (invariant)");
  }

  return {
    fixture_id: fixture.id,
    kind: fixture.kind,
    passed: failures.length === 0,
    failures,
  };
}

export function aggregateScores(
  pairs: Array<{ fixture: OracleFixture; decision: RetrievalDecision }>,
): OracleAggregate {
  let wrongInjected = 0;
  let wrongTotal = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let abstainExpected = 0;
  let abstainCorrect = 0;
  let passed = 0;
  let mustNotRegressPass = true;

  for (const { fixture, decision } of pairs) {
    const injected = new Set(decision.injected);

    wrongTotal += fixture.expect.must_not_inject.length;
    for (const id of fixture.expect.must_not_inject) {
      if (injected.has(id)) wrongInjected++;
    }

    const ns = (id: string) => `${fixture.id}:${id}`;
    const pr = precisionRecall(
      decision.injected.map(ns),
      fixture.expect.must_inject.map(ns),
    );
    tp += pr.true_positives;
    fp += pr.false_positives;
    fn += pr.false_negatives;

    if (fixture.expect.must_abstain) {
      abstainExpected++;
      if (decision.abstained) abstainCorrect++;
    }

    const score = scoreFixture(fixture, decision);
    if (score.passed) passed++;
    if (fixture.must_not_regress && !score.passed) mustNotRegressPass = false;
  }

  return {
    wrong_injection_rate: wrongTotal === 0 ? 0 : wrongInjected / wrongTotal,
    inject_precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    inject_recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    abstain_correctness: abstainExpected === 0 ? 1 : abstainCorrect / abstainExpected,
    must_not_regress_pass: mustNotRegressPass,
    total: pairs.length,
    passed,
  };
}
