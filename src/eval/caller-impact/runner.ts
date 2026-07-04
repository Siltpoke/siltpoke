// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { type EvalExample, type EvalManifest, freezeGuard } from "./manifest";
import {
  type EvalFinding,
  type SemanticGrader,
  scoreExample,
} from "./oracle";

/**
 * The four arms of the caller-impact probe:
 * - baseline            : no caller block at all (control floor)
 * - grep-sigdelta       : plain ripgrep caller resolver on signature delta
 * - graph-sigdelta      : repo-graph caller resolver on signature delta
 * - coherent-irrelevant : real caller context but for the WRONG target,
 *                          same token budget (coherence ≠ relevance control)
 */
export const ARMS = [
  "baseline",
  "grep-sigdelta",
  "graph-sigdelta",
  "coherent-irrelevant",
] as const;

export type Arm = (typeof ARMS)[number];

/**
 * INJECTED seam. Real impl (gated, later) runs the critic with the arm's
 * resolver config and returns what it surfaced. NO real impl exists here —
 * tests pass a scripted fake; `run-eval.ts` ships a throwing stub.
 */
export type RunArm = (
  example: EvalExample,
  arm: Arm,
) => Promise<EvalFinding[]>;

/** Per-(example, arm) outcome across `repeats` runs (LLM non-determinism). */
export interface ExampleArmResult {
  exampleId: string;
  arm: Arm;
  isControl: boolean;
  /** caught[r] for each repeat r (deterministic primary oracle). */
  caughtPerRepeat: boolean[];
  /** falsePositive[r] for each repeat r (controls only; else all false). */
  falsePositivePerRepeat: boolean[];
  /** Majority-vote central value across repeats. */
  caughtCentral: boolean;
  /** Fraction of repeats that caught (spread indicator). */
  caughtRate: number;
  /** semanticConfirmed central value, if a grader was supplied. */
  semanticConfirmedCentral?: boolean;
}

export interface ArmTable {
  arm: Arm;
  /** Per-example caught central values, in example order (non-controls only). */
  caught: boolean[];
  /** Example ids aligned with `caught`. */
  exampleIds: string[];
  catchCount: number;
  /** Controls only: how many controls produced any finding. */
  falsePositiveCount: number;
  controlCount: number;
  fpRate: number;
}

export interface ArmResults {
  ok: boolean;
  reason?: string;
  repeats: number;
  perExampleArm: ExampleArmResult[];
  armTables: Record<Arm, ArmTable>;
}

function majority(bools: boolean[]): boolean {
  if (bools.length === 0) return false;
  const trues = bools.filter(Boolean).length;
  return trues * 2 > bools.length;
}

export interface RunOptions {
  repeats?: number;
  grader?: SemanticGrader;
}

/**
 * Feed every example through every arm `repeats` times via the injected
 * `runArm` seam, score each result through the oracle, and accumulate per-arm
 * catch tables + control FP rates.
 *
 * INV2: freezeGuard runs FIRST over `manifest.examples`; on drift the runner
 * refuses (returns `{ ok: false }`) and performs ZERO arm calls.
 *
 * Ordering is deterministic (examples in manifest order, arms in ARMS order,
 * repeats sequential) so a fake runArm yields reproducible counts.
 */
export async function runArmsOverSet(
  manifest: EvalManifest,
  runArm: RunArm,
  options: RunOptions = {},
): Promise<ArmResults> {
  const repeats = options.repeats ?? 1;
  if (repeats < 1) {
    throw new Error("repeats must be >= 1");
  }

  // INV2: refuse to run on frozen-set drift, BEFORE any arm call.
  const guard = freezeGuard(manifest, manifest.examples);
  if (!guard.ok) {
    return {
      ok: false,
      reason: guard.reason,
      repeats,
      perExampleArm: [],
      armTables: emptyArmTables(),
    };
  }

  const perExampleArm: ExampleArmResult[] = [];
  const armTables = emptyArmTables();

  for (const arm of ARMS) {
    const table = armTables[arm];
    for (const example of manifest.examples) {
      const cell = await scoreCell(example, arm, runArm, repeats, options);
      perExampleArm.push(cell);
      accumulate(table, example, cell);
    }
    table.fpRate =
      table.controlCount > 0
        ? table.falsePositiveCount / table.controlCount
        : 0;
  }

  return { ok: true, repeats, perExampleArm, armTables };
}

/** Run one (example, arm) cell `repeats` times and score each run. */
async function scoreCell(
  example: EvalExample,
  arm: Arm,
  runArm: RunArm,
  repeats: number,
  options: RunOptions,
): Promise<ExampleArmResult> {
  const caughtPerRepeat: boolean[] = [];
  const fpPerRepeat: boolean[] = [];
  let semanticConfirmedAny = false;

  for (let r = 0; r < repeats; r++) {
    const findings = await runArm(example, arm);
    const score = await scoreExample(
      example.plantedBug,
      findings,
      options.grader,
    );
    caughtPerRepeat.push(score.caught);
    fpPerRepeat.push(score.falsePositive ?? false);
    if (score.semanticConfirmed) semanticConfirmedAny = true;
  }

  return {
    exampleId: example.id,
    arm,
    isControl: example.isControl,
    caughtPerRepeat,
    falsePositivePerRepeat: fpPerRepeat,
    caughtCentral: majority(caughtPerRepeat),
    caughtRate:
      caughtPerRepeat.filter(Boolean).length / caughtPerRepeat.length,
    ...(options.grader !== undefined
      ? { semanticConfirmedCentral: semanticConfirmedAny }
      : {}),
  };
}

/** Fold one scored cell into its arm's running table. */
function accumulate(
  table: ArmTable,
  example: EvalExample,
  cell: ExampleArmResult,
): void {
  if (example.isControl) {
    table.controlCount += 1;
    if (majority(cell.falsePositivePerRepeat)) table.falsePositiveCount += 1;
    return;
  }
  table.exampleIds.push(example.id);
  table.caught.push(cell.caughtCentral);
  if (cell.caughtCentral) table.catchCount += 1;
}

function emptyArmTables(): Record<Arm, ArmTable> {
  const tables = {} as Record<Arm, ArmTable>;
  for (const arm of ARMS) {
    tables[arm] = {
      arm,
      caught: [],
      exampleIds: [],
      catchCount: 0,
      falsePositiveCount: 0,
      controlCount: 0,
      fpRate: 0,
    };
  }
  return tables;
}
