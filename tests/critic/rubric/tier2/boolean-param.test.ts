import { describe, test, expect } from "bun:test";
import { booleanParamRule } from "../../../../src/critic/rubric/tier2/boolean-param";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-bp-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeTsFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("boolean-param rule", () => {
  test("setVisible(true, false) with 2 args and 1 bool → MED trigger", async () => {
    const src = `setVisible(true, false);\n`;
    const path = writeTsFile("bp1.ts", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
    expect(result.triggers[0].rule_id).toBe("boolean-param");
  });

  test("setVisible(true) with 1 arg → no trigger (single arg)", async () => {
    const src = `setVisible(true);\n`;
    const path = writeTsFile("bp2.ts", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("setVisible(visible) named var → no trigger (no boolean literal)", async () => {
    const src = `setVisible(visible);\n`;
    const path = writeTsFile("bp3.ts", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("fn(true, x, y) with 3 args, 1 bool → MED trigger", async () => {
    const src = `process(true, x, y);\n`;
    const path = writeTsFile("bp4.ts", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
  });

  test("5 bool calls in same file → at most 3 triggers (spam cap)", async () => {
    const src = `${[
      `call1(true, x);`,
      `call2(false, y);`,
      `call3(true, z);`,
      `call4(false, a);`,
      `call5(true, b);`,
    ].join("\n")}\n`;
    const path = writeTsFile("bp5.ts", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers.length).toBeLessThanOrEqual(3);
    expect(result.triggers.length).toBeGreaterThan(0);
  });

  test("no bool args at all → no trigger", async () => {
    const src = `compute(x, y, z);\n`;
    const path = writeTsFile("bp6.ts", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("unsupported file extension → no trigger", async () => {
    const src = `setVisible(true, false)\n`;
    const path = writeTsFile("bp.rb", src);
    const result = await booleanParamRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });
});
