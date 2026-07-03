import { describe, test, expect } from "bun:test";
import { magicNumberRule } from "../../../../src/critic/rubric/tier2/magic-number";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-mn-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("magic-number rule", () => {
  test("setTimeout(fn, 5000) → MED trigger", async () => {
    const src = `setTimeout(fn, 5000);\n`;
    const path = writeFile("mn1.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
    expect(result.triggers[0].rule_id).toBe("magic-number");
  });

  test("const TIMEOUT = 5000 → no trigger (named constant)", async () => {
    const src = `const TIMEOUT = 5000;\n`;
    const path = writeFile("mn2.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("const x = 0 → no trigger (whitelisted zero)", async () => {
    const src = `const x = 0;\n`;
    const path = writeFile("mn3.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("const x = 100 → no trigger (whitelisted 100)", async () => {
    const src = `const x = 100;\n`;
    const path = writeFile("mn4.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("const x = 1 → no trigger (whitelisted 1)", async () => {
    const src = `const x = 1;\n`;
    const path = writeFile("mn5.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("const x = -1 → no trigger (whitelisted -1)", async () => {
    const src = `const x = -1;\n`;
    const path = writeFile("mn6.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("config.ts file → no trigger (config file skip)", async () => {
    const src = `setTimeout(fn, 5000);\n`;
    const path = writeFile("config.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("constants.ts file → no trigger (constants file skip)", async () => {
    const src = `const x = retry(3);\n`;
    const path = writeFile("constants.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("foo.test.ts file → no trigger (test file skip)", async () => {
    const src = `expect(result).toBe(42);\n`;
    const path = writeFile("foo.test.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("foo.spec.ts file → no trigger (spec file skip)", async () => {
    const src = `expect(count).toBe(42);\n`;
    const path = writeFile("foo.spec.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("let x = 42 → trigger (let, not const)", async () => {
    const src = `let retries = 42;\n`;
    const path = writeFile("mn7.ts", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
  });

  test("unsupported extension → no trigger", async () => {
    const src = `retry(5000)\n`;
    const path = writeFile("mn.rb", src);
    const result = await magicNumberRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });
});
