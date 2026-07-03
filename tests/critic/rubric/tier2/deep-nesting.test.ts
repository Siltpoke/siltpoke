import { describe, test, expect } from "bun:test";
import { deepNestingRule } from "../../../../src/critic/rubric/tier2/deep-nesting";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-dn-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeTsFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("deep-nesting rule", () => {
  test("3-level nesting (if > for > while) → no trigger", async () => {
    const src = `
function threeLevels(a: number[]) {
  if (a.length > 0) {
    for (const x of a) {
      while (x > 0) {
        break;
      }
    }
  }
}
`.trim();
    const path = writeTsFile("three-levels.ts", src);
    const result = await deepNestingRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("4-level nesting → HIGH trigger", async () => {
    const src = `
function fourLevels(a: number[]) {
  if (a.length > 0) {
    for (const x of a) {
      while (x > 0) {
        if (x > 10) {
          break;
        }
      }
    }
  }
}
`.trim();
    const path = writeTsFile("four-levels.ts", src);
    const result = await deepNestingRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    const t = result.triggers[0];
    expect(t.severity).toBe("high");
    expect(t.rule_id).toBe("deep-nesting");
    expect(t.message).toContain("depth");
  });

  test("5-level nesting → HIGH trigger", async () => {
    const src = `
function fiveLevels(x: number) {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      while (i > 0) {
        try {
          if (i > 5) {
            console.log(i);
          }
        } catch (e) {}
      }
    }
  }
}
`.trim();
    const path = writeTsFile("five-levels.ts", src);
    const result = await deepNestingRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("high");
  });

  test("Python: 4-level nesting → HIGH trigger", async () => {
    const src = `
def four_levels(a):
    if a:
        for x in a:
            while x > 0:
                if x > 10:
                    break
`.trim();
    const path = writeTsFile("four-levels.py", src);
    const result = await deepNestingRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("high");
  });

  test("Python: 3-level nesting → no trigger", async () => {
    const src = `
def three_levels(a):
    if a:
        for x in a:
            while x > 0:
                break
`.trim();
    const path = writeTsFile("three-py.py", src);
    const result = await deepNestingRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("flat code → no trigger", async () => {
    const src = `const x = 1;\nconst y = x + 2;\n`;
    const path = writeTsFile("flat.ts", src);
    const result = await deepNestingRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("unreadable file → graceful no trigger", async () => {
    const result = await deepNestingRule.run(makeInput("/nonexistent/path/file.ts"));
    expect(result.triggers).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});
