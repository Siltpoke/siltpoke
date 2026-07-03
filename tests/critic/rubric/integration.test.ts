import { describe, test, expect } from "bun:test";
import { runRubric } from "../../../src/critic/rubric/engine";
import { ALL_RUBRIC_RULES } from "../../../src/critic/rubric/rules";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("rubric integration", () => {
  test("runs all 11 rules against a fixture file w/o crash", async () => {
    const dir = join(tmpdir(), `siltpoke-rubric-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "test.ts");
    writeFileSync(file, `
      // increment counter
      let count = 0;
      function bigFn(a: any, b: any, c: any, d: any, e: any, f: any) {
        try { count++; } catch (e) { console.log(e); }
        if (a) { if (b) { if (c) { if (d) { count = 42; } } } }
        callSomething(true, false);
      }
    `);
    const result = await runRubric({ cwd: dir, changedFiles: [file], diffHunks: [] }, ALL_RUBRIC_RULES);
    expect(result.errors).toHaveLength(0);
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.rule_results.length).toBeGreaterThanOrEqual(8); // tier-2 ts rules run
    rmSync(dir, { recursive: true });
  });
});
