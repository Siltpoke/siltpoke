// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Hard cost gate for the paid eval. Honest-metrics discipline: a paid run
 * is refused unless an explicit `--max-usd` ceiling is given, the pre-run
 * projection fits under it, AND a running tracker aborts the instant actual
 * spend crosses the ceiling (so a mid-run cost surprise can't overrun it).
 */

/**
 * Per-call USD estimates (generous upper-bound; real cost is logged from usage).
 * Calibrated from the lean run: blended ~$0.12-0.24/call, the Sonnet grader being
 * the driver. These are intentionally on the high side so the gate over-projects
 * (refuses early) rather than under-projects (overruns).
 */
export const DEFAULT_PER_ARM_USD = 0.08; // Haiku critic call on a real diff + caller block
export const DEFAULT_PER_GRADER_USD = 0.2; // Sonnet grader call, per finding

export class CostCeilingExceeded extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly ceilingUsd: number,
  ) {
    super(
      `cost ceiling exceeded: spent $${spentUsd.toFixed(4)} > ceiling $${ceilingUsd.toFixed(4)} — run aborted`,
    );
    this.name = "CostCeilingExceeded";
  }
}

export interface SpendProjection {
  armCalls: number;
  graderCallsUpperBound: number;
  perArmUsd: number;
  perGraderUsd: number;
  projectedUsd: number;
  lines: string[];
}

/** Project worst-case spend from a dry-run plan's call counts. */
export function projectSpend(
  plan: { estimatedArmCalls: number; estimatedGraderCallsUpperBound: number },
  perArmUsd: number = DEFAULT_PER_ARM_USD,
  perGraderUsd: number = DEFAULT_PER_GRADER_USD,
): SpendProjection {
  const armUsd = plan.estimatedArmCalls * perArmUsd;
  const graderUsd = plan.estimatedGraderCallsUpperBound * perGraderUsd;
  const projectedUsd = armUsd + graderUsd;
  return {
    armCalls: plan.estimatedArmCalls,
    graderCallsUpperBound: plan.estimatedGraderCallsUpperBound,
    perArmUsd,
    perGraderUsd,
    projectedUsd,
    lines: [
      `projected arm spend:    ${plan.estimatedArmCalls} calls × $${perArmUsd} = $${armUsd.toFixed(4)}`,
      `projected grader spend: ≤${plan.estimatedGraderCallsUpperBound} calls × $${perGraderUsd} = $${graderUsd.toFixed(4)} (upper bound)`,
      `projected TOTAL (upper bound): $${projectedUsd.toFixed(4)}`,
    ],
  };
}

export interface GateDecision {
  ok: boolean;
  reason: string;
}

/** Pre-run gate: refuse if no ceiling, ceiling ≤ 0, or projection exceeds it. */
export function checkGate(projection: SpendProjection, ceilingUsd: number | undefined): GateDecision {
  if (ceilingUsd === undefined || Number.isNaN(ceilingUsd)) {
    return { ok: false, reason: "no cost ceiling — paid run requires --max-usd <n>" };
  }
  if (ceilingUsd <= 0) {
    return { ok: false, reason: `cost ceiling must be > 0 (got ${ceilingUsd})` };
  }
  if (projection.projectedUsd > ceilingUsd) {
    return {
      ok: false,
      reason: `projected $${projection.projectedUsd.toFixed(4)} exceeds ceiling $${ceilingUsd.toFixed(4)} — raise --max-usd or shrink the set`,
    };
  }
  return { ok: true, reason: `projected $${projection.projectedUsd.toFixed(4)} within ceiling $${ceilingUsd.toFixed(4)}` };
}

/**
 * Running spend tracker. `add` each call's actual `total_cost_usd`; the instant
 * cumulative spend crosses the ceiling it THROWS, aborting the in-flight run.
 */
export class SpendTracker {
  private spent = 0;
  constructor(private readonly ceilingUsd: number) {}
  get spentUsd(): number {
    return this.spent;
  }
  add(usd: number | null | undefined): void {
    this.spent += usd ?? 0;
    if (this.spent > this.ceilingUsd) {
      throw new CostCeilingExceeded(this.spent, this.ceilingUsd);
    }
  }
}
