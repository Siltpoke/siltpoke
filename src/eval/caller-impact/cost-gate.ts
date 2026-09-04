// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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

/**
 * Call-count analog of `CostCeilingExceeded` (track #7 T5, AC12) — quota-billed
 * providers (codex) have no meaningful `--max-usd`; the hard ceiling is a call
 * COUNT instead of a dollar amount. Kept as a DISTINCT class (not a `total_cost_usd`
 * repurpose) so its message stays honest about the unit being counted.
 */
export class CallCeilingExceeded extends Error {
  constructor(
    public readonly callsMade: number,
    public readonly ceilingCalls: number,
  ) {
    super(
      `call ceiling exceeded: made ${callsMade} calls > ceiling ${ceilingCalls} — run aborted`,
    );
    this.name = "CallCeilingExceeded";
  }
}

export interface CallGateDecision {
  ok: boolean;
  reason: string;
}

/**
 * Pre-run gate for quota-billed (call-counted) providers — sibling of
 * `checkGate`: refuse if no ceiling, ceiling <= 0, or the plan's estimated
 * arm calls exceed it.
 */
export function checkCallGate(
  estimatedArmCalls: number,
  ceilingCalls: number | undefined,
): CallGateDecision {
  if (ceilingCalls === undefined || Number.isNaN(ceilingCalls)) {
    return { ok: false, reason: "no call ceiling — quota-billed run requires --max-calls <n>" };
  }
  if (ceilingCalls <= 0) {
    return { ok: false, reason: `call ceiling must be > 0 (got ${ceilingCalls})` };
  }
  if (estimatedArmCalls > ceilingCalls) {
    return {
      ok: false,
      reason: `estimated ${estimatedArmCalls} arm calls exceeds ceiling ${ceilingCalls} — raise --max-calls or shrink the set/repeats`,
    };
  }
  return { ok: true, reason: `estimated ${estimatedArmCalls} arm calls within ceiling ${ceilingCalls}` };
}

/**
 * Running call-count tracker. `add()` once per call made; the instant the
 * count crosses the ceiling it THROWS, aborting the in-flight run — same
 * abort discipline as `SpendTracker`, one call unit instead of one dollar.
 */
export class CallCountTracker {
  private count = 0;
  constructor(private readonly ceilingCalls: number) {}
  get callsMade(): number {
    return this.count;
  }
  add(): void {
    this.count += 1;
    if (this.count > this.ceilingCalls) {
      throw new CallCeilingExceeded(this.count, this.ceilingCalls);
    }
  }
}
