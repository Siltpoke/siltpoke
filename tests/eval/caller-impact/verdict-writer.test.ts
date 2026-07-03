import { describe, expect, it } from "bun:test";
import {
  computeContentHash,
  type EvalExample,
  type EvalManifest,
} from "../../../src/eval/caller-impact/manifest";
import type { EvalFinding } from "../../../src/eval/caller-impact/oracle";
import { buildDryRunPlan, main } from "../../../src/eval/caller-impact/run-eval";
import {
  type Arm,
  type RunArm,
  runArmsOverSet,
} from "../../../src/eval/caller-impact/runner";
import { writeVerdictMd } from "../../../src/eval/caller-impact/verdict-writer";

function plantedExample(id: string, file: string): EvalExample {
  return {
    id,
    repo: "r",
    diff: id,
    plantedBug: { file, function: "fn", line: 10 },
    isControl: false,
  };
}

function manifestOf(examples: EvalExample[]): EvalManifest {
  return { version: "1", examples, contentHash: computeContentHash(examples) };
}

// graph catches all; grep catches none => strong graph signal.
const graphWinsRunArm: RunArm = async (
  ex: EvalExample,
  arm: Arm,
): Promise<EvalFinding[]> => {
  if (ex.isControl) return [];
  if (arm === "graph-sigdelta" && ex.plantedBug) {
    return [{ file: ex.plantedBug.file, function: ex.plantedBug.function }];
  }
  return [];
};

describe("writeVerdictMd", () => {
  it("renders catch table, McNemar, and an earns-keep line", async () => {
    const examples = Array.from({ length: 8 }, (_, i) =>
      plantedExample(`p${i}`, `src/f${i}.ts`),
    );
    const results = await runArmsOverSet(manifestOf(examples), graphWinsRunArm);
    const report = writeVerdictMd(results);

    expect(report.body).toContain("graph earns keep:");
    expect(report.body).toContain("Per-arm catch");
    expect(report.body).toContain("McNemar");
    expect(report.body).toContain("Wilson");
    // 8 discordant pairs all graph-caught => significant => yes.
    expect(report.verdict.earnsKeep).toBe("yes");
    expect(report.body).toContain("Honest limits");
    expect(report.body).toContain("OQ4");
  });

  it("reports underpowered honestly with too few examples", async () => {
    const examples = [plantedExample("p0", "src/a.ts")];
    const results = await runArmsOverSet(manifestOf(examples), graphWinsRunArm);
    const report = writeVerdictMd(results);
    expect(report.verdict.earnsKeep).toBe("underpowered");
  });

  it("renders an ABORTED body when the runner refused (INV2)", async () => {
    const examples = [plantedExample("p0", "src/a.ts")];
    const drifted: EvalManifest = {
      ...manifestOf(examples),
      contentHash: "tampered",
    };
    const results = await runArmsOverSet(drifted, graphWinsRunArm);
    const report = writeVerdictMd(results);
    expect(report.body).toContain("ABORTED");
  });
});

describe("run-eval (paid gate)", () => {
  it("buildDryRunPlan counts arm calls = examples × arms × repeats", () => {
    const examples = [
      plantedExample("p0", "src/a.ts"),
      plantedExample("p1", "src/b.ts"),
    ];
    const plan = buildDryRunPlan(manifestOf(examples), 3);
    // 2 examples × 4 arms × 3 repeats = 24.
    expect(plan.estimatedArmCalls).toBe(24);
    expect(plan.armCount).toBe(4);
  });

  it("main() without --execute returns 0 and does not throw", async () => {
    const code = await main([]);
    expect(code).toBe(0);
  });

  it("main() with --execute but missing frozen set → refuses (returns 1, no paid work)", async () => {
    // Point at a NON-EXISTENT manifest so the gate refuses before any Brain
    // call. (Must NOT use the default path — the real frozen-manifest.json now
    // exists there, and --execute against it would make real paid calls in the
    // test suite.) Cost-gate refusal paths are unit-tested in cost-gate.test.ts.
    const code = await main(["--execute", "--max-usd", "100", "--manifest", "/nonexistent/frozen-x.json"]);
    expect(code).toBe(1);
  });
});
