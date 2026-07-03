import { describe, expect, it } from "bun:test";
import {
  computeContentHash,
  type EvalExample,
  type EvalManifest,
} from "../../../src/eval/caller-impact/manifest";
import type { EvalFinding } from "../../../src/eval/caller-impact/oracle";
import {
  ARMS,
  type Arm,
  type RunArm,
  runArmsOverSet,
} from "../../../src/eval/caller-impact/runner";

const planted1: EvalExample = {
  id: "p1",
  repo: "r",
  diff: "d1",
  plantedBug: { file: "src/a.ts", function: "fnA", line: 10 },
  isControl: false,
};
const planted2: EvalExample = {
  id: "p2",
  repo: "r",
  diff: "d2",
  plantedBug: { file: "src/b.ts", function: "fnB", line: 20 },
  isControl: false,
};
const control1: EvalExample = {
  id: "c1",
  repo: "r",
  diff: "d3",
  plantedBug: null,
  isControl: true,
};

function manifestOf(examples: EvalExample[]): EvalManifest {
  return {
    version: "1",
    examples,
    contentHash: computeContentHash(examples),
  };
}

/**
 * Scripted fake: graph-sigdelta catches both planted bugs; grep-sigdelta only
 * catches p1; baseline catches nothing; coherent-irrelevant catches nothing but
 * surfaces a finding on the control (a false positive).
 */
const scriptedRunArm: RunArm = async (
  ex: EvalExample,
  arm: Arm,
): Promise<EvalFinding[]> => {
  if (ex.isControl) {
    return arm === "coherent-irrelevant"
      ? [{ file: "src/unrelated.ts", line: 1 }]
      : [];
  }
  if (arm === "graph-sigdelta") {
    return ex.plantedBug
      ? [{ file: ex.plantedBug.file, function: ex.plantedBug.function }]
      : [];
  }
  if (arm === "grep-sigdelta" && ex.id === "p1" && ex.plantedBug) {
    return [{ file: ex.plantedBug.file, line: ex.plantedBug.line }];
  }
  return [];
};

describe("runArmsOverSet", () => {
  it("produces correct per-arm catch counts from a scripted runArm", async () => {
    const manifest = manifestOf([planted1, planted2, control1]);
    const results = await runArmsOverSet(manifest, scriptedRunArm);

    expect(results.ok).toBe(true);
    expect(results.armTables["graph-sigdelta"].catchCount).toBe(2);
    expect(results.armTables["grep-sigdelta"].catchCount).toBe(1);
    expect(results.armTables.baseline.catchCount).toBe(0);
    expect(results.armTables["coherent-irrelevant"].catchCount).toBe(0);
  });

  it("computes FP rate on controls per arm", async () => {
    const manifest = manifestOf([planted1, planted2, control1]);
    const results = await runArmsOverSet(manifest, scriptedRunArm);

    expect(results.armTables["coherent-irrelevant"].controlCount).toBe(1);
    expect(results.armTables["coherent-irrelevant"].falsePositiveCount).toBe(1);
    expect(results.armTables["coherent-irrelevant"].fpRate).toBe(1);
    expect(results.armTables["graph-sigdelta"].fpRate).toBe(0);
  });

  it("aligns caught arrays by example id (controls excluded)", async () => {
    const manifest = manifestOf([planted1, planted2, control1]);
    const results = await runArmsOverSet(manifest, scriptedRunArm);
    const t = results.armTables["graph-sigdelta"];
    expect(t.exampleIds).toEqual(["p1", "p2"]);
    expect(t.caught).toEqual([true, true]);
  });

  it("REFUSES on frozen-set drift (INV2) and makes zero arm calls", async () => {
    const manifest = manifestOf([planted1, planted2]);
    // Tamper the manifest hash to simulate drift.
    const drifted: EvalManifest = { ...manifest, contentHash: "deadbeef" };

    let calls = 0;
    const countingRunArm: RunArm = async () => {
      calls += 1;
      return [];
    };

    const results = await runArmsOverSet(drifted, countingRunArm);
    expect(results.ok).toBe(false);
    expect(results.reason).toContain("drift");
    expect(calls).toBe(0);
  });

  it("supports repeats and records central value + spread", async () => {
    const manifest = manifestOf([planted1]);
    let r = 0;
    // Flaky arm: catches on 2 of 3 repeats => majority caught.
    const flakyRunArm: RunArm = async (ex, arm) => {
      if (arm !== "graph-sigdelta" || !ex.plantedBug) return [];
      const idx = r++;
      return idx === 1
        ? []
        : [{ file: ex.plantedBug.file, function: ex.plantedBug.function }];
    };
    const results = await runArmsOverSet(manifest, flakyRunArm, {
      repeats: 3,
    });
    const cell = results.perExampleArm.find(
      (c) => c.arm === "graph-sigdelta" && c.exampleId === "p1",
    );
    expect(cell?.caughtCentral).toBe(true);
    expect(cell?.caughtRate).toBeCloseTo(2 / 3, 5);
    expect(cell?.caughtPerRepeat).toEqual([true, false, true]);
  });

  it("runs all four arms in deterministic order", async () => {
    const manifest = manifestOf([planted1]);
    const seen: Arm[] = [];
    const recordingRunArm: RunArm = async (_ex, arm) => {
      if (!seen.includes(arm)) seen.push(arm);
      return [];
    };
    await runArmsOverSet(manifest, recordingRunArm);
    expect(seen).toEqual([...ARMS]);
  });
});
