import { describe, expect, it } from "bun:test";
import type { PlantedBug } from "../../../src/eval/caller-impact/manifest";
import {
  deterministicCatch,
  type EvalFinding,
  type SemanticGrader,
  scoreExample,
} from "../../../src/eval/caller-impact/oracle";

const planted: PlantedBug = {
  file: "src/foo.ts",
  function: "doFoo",
  line: 42,
};

describe("deterministicCatch", () => {
  it("catches on exact file + function match", () => {
    const findings: EvalFinding[] = [
      { file: "src/foo.ts", function: "doFoo" },
    ];
    expect(deterministicCatch(planted, findings)).toBe(true);
  });

  it("catches on file + line within ±window", () => {
    const findings: EvalFinding[] = [{ file: "src/foo.ts", line: 45 }];
    expect(deterministicCatch(planted, findings, 5)).toBe(true);
  });

  it("misses on file + line outside window", () => {
    const findings: EvalFinding[] = [{ file: "src/foo.ts", line: 60 }];
    expect(deterministicCatch(planted, findings, 5)).toBe(false);
  });

  it("misses on wrong file even if function name matches", () => {
    const findings: EvalFinding[] = [
      { file: "src/other.ts", function: "doFoo", line: 42 },
    ];
    expect(deterministicCatch(planted, findings)).toBe(false);
  });

  it("misses on right file but no function and no line", () => {
    const findings: EvalFinding[] = [{ file: "src/foo.ts" }];
    expect(deterministicCatch(planted, findings)).toBe(false);
  });
});

describe("scoreExample", () => {
  it("scores caught when deterministic oracle matches", async () => {
    const result = await scoreExample(planted, [
      { file: "src/foo.ts", function: "doFoo" },
    ]);
    expect(result.caught).toBe(true);
  });

  it("scores miss when nothing matches", async () => {
    const result = await scoreExample(planted, [{ file: "src/zzz.ts" }]);
    expect(result.caught).toBe(false);
  });

  it("control (planted=null) with a finding => false positive", async () => {
    const result = await scoreExample(null, [{ file: "src/anything.ts" }]);
    expect(result.caught).toBe(false);
    expect(result.falsePositive).toBe(true);
  });

  it("control (planted=null) with no findings => no false positive", async () => {
    const result = await scoreExample(null, []);
    expect(result.falsePositive).toBe(false);
  });

  it("records secondary semantic confirmation from an injected grader", async () => {
    const grader: SemanticGrader = async () => ({ aboutPlanted: true });
    const result = await scoreExample(
      planted,
      [{ file: "src/foo.ts", function: "doFoo" }],
      grader,
    );
    expect(result.caught).toBe(true);
    expect(result.semanticConfirmed).toBe(true);
  });

  it("grader that withholds confirmation does not flip caught", async () => {
    const grader: SemanticGrader = async () => ({ aboutPlanted: false });
    const result = await scoreExample(
      planted,
      [{ file: "src/foo.ts", function: "doFoo" }],
      grader,
    );
    expect(result.caught).toBe(true);
    expect(result.semanticConfirmed).toBe(false);
  });

  it("never leaks the arm label to the grader (blindness)", async () => {
    const seenArms: string[] = [];
    const grader: SemanticGrader = async ({ arm }) => {
      seenArms.push(arm);
      return { aboutPlanted: false };
    };
    await scoreExample(planted, [{ file: "src/foo.ts", line: 42 }], grader);
    expect(seenArms).toEqual(["<withheld-from-grader>"]);
  });
});
