import { describe, test, expect } from "bun:test";
import { godFunctionRule } from "../../../../src/critic/rubric/tier2/god-function";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-gf-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeTsFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("god-function rule", () => {
  test("30-line function → no trigger", async () => {
    // 30 lines including function declaration: well under 50 LOC threshold
    const lines = Array.from({ length: 28 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const src = `function shortFn() {\n${lines}\n}`;
    const path = writeTsFile("short.ts", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("60-line function → HIGH trigger (LOC >50)", async () => {
    // 58 body lines + 2 (open/close) = 60 lines
    const lines = Array.from({ length: 58 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const src = `function longFn() {\n${lines}\n}`;
    const path = writeTsFile("long.ts", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    const t = result.triggers[0];
    expect(t.severity).toBe("high");
    expect(t.rule_id).toBe("god-function");
    expect(t.message).toContain("LOC");
  });

  test("nested if/else chain with cognitive complexity >15 → HIGH trigger", async () => {
    // Each if/else-if/catch raises complexity. Build ~18 complexity:
    // 6 nested ifs (each contributes +1 base +1 per nesting level) plus ternaries
    const src = `
function complexFn(a: number, b: number, c: number): string {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (a > b) {
          if (b > c) {
            return a > 10 ? "big" : "small";
          } else {
            return b > 10 ? "big" : "small";
          }
        } else {
          return c > 10 ? "big" : "small";
        }
      } else {
        if (a > b) {
          return a > 0 && b > 0 ? "pos" : "neg";
        }
      }
    } else {
      if (c < 0) {
        return a > 0 || c > 0 ? "mixed" : "all-neg";
      }
    }
  }
  return "zero";
}
`.trim();
    const path = writeTsFile("complex.ts", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    const t = result.triggers[0];
    expect(t.severity).toBe("high");
    expect(t.rule_id).toBe("god-function");
    expect(t.message).toContain("complexity");
  });

  test("Python: function over 50 lines → HIGH trigger", async () => {
    const bodyLines = Array.from({ length: 52 }, (_, i) => `    x${i} = ${i}`).join("\n");
    const src = `def long_py_fn(a, b):\n${bodyLines}\n    return a`;
    const path = writeTsFile("long.py", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("high");
  });

  test("file with no functions → no trigger", async () => {
    const src = `const x = 1;\nconst y = 2;\n`;
    const path = writeTsFile("nofunc.ts", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("unreadable file path → graceful no trigger", async () => {
    const result = await godFunctionRule.run(makeInput("/nonexistent/path/file.ts"));
    expect(result.triggers).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  test("60-line JSX-only component with low complexity → no trigger (FP: layout components)", async () => {
    // A large render-only React component — lots of LOC, but zero control-flow complexity.
    // Was causing ~35% FP rate on TSX files. Should be skipped when JSX-dominant + complexity < 10.
    const jsxLines = Array.from(
      { length: 55 },
      (_, i) => `      <div key={${i}} className="item-${i}">item</div>`,
    ).join("\n");
    const src = `
function BigLayoutComponent() {
  return (
    <div className="wrapper">
${jsxLines}
    </div>
  );
}
`.trim();
    const path = writeTsFile("layout.tsx", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("60-line JSX component WITH high complexity → still triggers", async () => {
    // JSX + real logic/branching means it IS a god function — should still trigger.
    const jsxLines = Array.from(
      { length: 30 },
      (_, i) => `      <div key={${i}} className="item-${i}">item</div>`,
    ).join("\n");
    const src = `
function ComplexComponent({ a, b, c, d }: { a: number; b: number; c: number; d: number }) {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (a > b) {
          if (b > c) {
            if (d > 0) {
              if (d > a) {
                if (d > b) {
                  if (d > c) {
                    return <span>deep</span>;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return (
    <div className="wrapper">
${jsxLines}
    </div>
  );
}
`.trim();
    const path = writeTsFile("complex-jsx.tsx", src);
    const result = await godFunctionRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
  });
});
