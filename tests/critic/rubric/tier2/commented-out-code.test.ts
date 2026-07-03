import { describe, test, expect } from "bun:test";
import { commentedOutCodeRule } from "../../../../src/critic/rubric/tier2/commented-out-code";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-coc-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeTsFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("commented-out-code rule", () => {
  test("two consecutive // console.log(x) → LOW trigger", async () => {
    const src = `const x = 1;\n// console.log(x);\n// console.log(x);\nconst y = 2;\n`;
    const path = writeTsFile("coc1.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("low");
    expect(result.triggers[0].rule_id).toBe("commented-out-code");
  });

  test("two consecutive English prose comments → no trigger", async () => {
    const src = `// english prose here\n// more prose to read\nconst x = 1;\n`;
    const path = writeTsFile("coc2.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("single commented code line → no trigger (need ≥2 consecutive)", async () => {
    const src = `const x = 1;\n// console.log(x);\nconst y = 2;\n`;
    const path = writeTsFile("coc3.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("4 consecutive parseable TS lines → LOW trigger", async () => {
    const src = `${[
      "const a = 1;",
      "// for (let i = 0;",
      "// i < 5; i++) {",
      "// console.log(i);",
      "// }",
      "const b = 2;",
    ].join("\n")}\n`;
    const path = writeTsFile("coc4.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("low");
  });

  test("unsupported extension → no trigger", async () => {
    const src = `// console.log(x)\n// console.log(y)\n`;
    const path = writeTsFile("coc.rb", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("JSDoc block comment → no trigger (not consecutive line comments)", async () => {
    const src = `/**\n * Parse input string\n * @param x - input\n */\nfunction parse(x: string) {}\n`;
    const path = writeTsFile("coc5.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("4 consecutive visual section divider comments → no trigger (FP: ~90% of commented-out-code hits)", async () => {
    // These are section separators, not commented-out code. Were causing ~90% FP rate.
    const src = `${[
      "const x = 1;",
      "// ─────────────────────────────────────────────────────────────────",
      "// =================================================================",
      "// -----------------------------------------------------------------",
      "// *****************************************************************",
      "const y = 2;",
    ].join("\n")}\n`;
    const path = writeTsFile("coc-dividers.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("mix of divider and real code comments → only real code triggers", async () => {
    // Dividers should be skipped; the real code block should still trigger.
    const src = `${[
      "// ─────────────────────────────────────────────────────────────────",
      "// ─────────────────────────────────────────────────────────────────",
      "const a = 1;",
      "// console.log(x);",
      "// console.log(y);",
    ].join("\n")}\n`;
    const path = writeTsFile("coc-mix.ts", src);
    const result = await commentedOutCodeRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(1);
  });
});
