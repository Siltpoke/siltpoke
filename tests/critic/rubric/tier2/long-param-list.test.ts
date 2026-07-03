import { describe, test, expect } from "bun:test";
import { longParamListRule } from "../../../../src/critic/rubric/tier2/long-param-list";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-lpl-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("long-param-list rule", () => {
  test("3 params → no trigger", async () => {
    const src = `function doThing(a: string, b: number, c: boolean): void {}`;
    const path = writeFile("three-params.ts", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("6 params → MED trigger", async () => {
    const src = `function bigFn(a: string, b: number, c: boolean, d: string, e: number, f: boolean): void {}`;
    const path = writeFile("six-params.ts", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    const t = result.triggers[0];
    expect(t.severity).toBe("med");
    expect(t.rule_id).toBe("long-param-list");
    expect(t.message).toContain("param");
  });

  test("5 params with self → no trigger (self excluded)", async () => {
    // Python: self + 4 real params = 4 effective = no trigger
    const src = `
def method(self, a, b, c, d):
    pass
`.trim();
    const path = writeFile("self-method.py", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("Python: 6 params with self → MED trigger (self excluded → 5 effective)", async () => {
    const src = `
def big_method(self, a, b, c, d, e):
    pass
`.trim();
    const path = writeFile("big-method.py", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
  });

  test("5 params with cls → no trigger (cls excluded)", async () => {
    const src = `
def classmethod_fn(cls, a, b, c, d):
    pass
`.trim();
    const path = writeFile("cls-method.py", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("5 params with ctx → no trigger (ctx excluded)", async () => {
    const src = `function handler(ctx: Context, a: string, b: number, c: boolean, d: string): void {}`;
    const path = writeFile("ctx-handler.ts", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("5 params with this → no trigger (this excluded)", async () => {
    // TypeScript explicit 'this' parameter
    const src = `function boundFn(this: MyClass, a: string, b: number, c: boolean, d: string): void {}`;
    const path = writeFile("this-param.ts", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("arrow function with 6 params → MED trigger", async () => {
    const src = `const fn = (a: string, b: number, c: boolean, d: string, e: number, f: boolean) => {};`;
    const path = writeFile("arrow-six.ts", src);
    const result = await longParamListRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
  });

  test("unreadable file → graceful no trigger", async () => {
    const result = await longParamListRule.run(makeInput("/nonexistent/path/file.ts"));
    expect(result.triggers).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});
