import { describe, test, expect } from "bun:test";
import { sprawlingAbstractionRule } from "../../../../src/critic/rubric/tier2/sprawling-abstraction";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-sa-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(
  files: string[],
  addedLines: Record<string, number[]>,
): ReturnType<typeof sprawlingAbstractionRule.run> extends Promise<infer R>
  ? Parameters<typeof sprawlingAbstractionRule.run>[0]
  : never {
  return {
    cwd: dir,
    changedFiles: files,
    diffHunks: files.map((f) => ({
      file: f,
      addedLines: addedLines[f] ?? [],
    })),
  };
}

describe("sprawling-abstraction rule", () => {
  test("new interface with 1 impl + 1 caller → trigger HIGH", async () => {
    // Interface file
    const ifacePath = writeFile(
      "widget.ts",
      `export interface Widget {\n  render(): void;\n}\n`,
    );
    // Implementer file
    const implPath = writeFile(
      "square-widget.ts",
      `import { Widget } from './widget';\nexport class SquareWidget implements Widget {\n  render() {}\n}\n`,
    );
    // Caller file
    const callerPath = writeFile(
      "app.ts",
      `import { Widget } from './widget';\nexport function run(w: Widget) { w.render(); }\n`,
    );

    const result = await sprawlingAbstractionRule.run(
      makeInput(
        [ifacePath, implPath, callerPath],
        {
          [ifacePath]: [1, 2, 3],
          [implPath]: [],
          [callerPath]: [],
        },
      ),
    );

    expect(result.triggers.length).toBeGreaterThan(0);
    const t = result.triggers[0];
    expect(t.severity).toBe("high");
    expect(t.rule_id).toBe("sprawling-abstraction");
  });

  test("new interface with 3 impls → no trigger", async () => {
    const dir2 = join(tmpdir(), `siltpoke-sa2-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });

    const ifacePath = join(dir2, "shape.ts");
    writeFileSync(
      ifacePath,
      `export interface Shape {\n  area(): number;\n}\n`,
    );
    writeFileSync(
      join(dir2, "circle.ts"),
      `import { Shape } from './shape';\nexport class Circle implements Shape { area() { return 0; } }\n`,
    );
    writeFileSync(
      join(dir2, "square.ts"),
      `import { Shape } from './shape';\nexport class Square implements Shape { area() { return 0; } }\n`,
    );
    writeFileSync(
      join(dir2, "triangle.ts"),
      `import { Shape } from './shape';\nexport class Triangle implements Shape { area() { return 0; } }\n`,
    );
    writeFileSync(
      join(dir2, "caller.ts"),
      `import { Shape } from './shape';\nfunction draw(s: Shape) { s.area(); }\n`,
    );

    const allFiles = [
      ifacePath,
      join(dir2, "circle.ts"),
      join(dir2, "square.ts"),
      join(dir2, "triangle.ts"),
      join(dir2, "caller.ts"),
    ];

    const result = await sprawlingAbstractionRule.run({
      cwd: dir2,
      changedFiles: allFiles,
      diffHunks: allFiles.map((f) => ({
        file: f,
        addedLines: f === ifacePath ? [1, 2, 3] : [],
      })),
    });

    expect(result.triggers).toHaveLength(0);
  });

  test("new interface with 0 callers → no trigger", async () => {
    const dir3 = join(tmpdir(), `siltpoke-sa3-${Date.now()}`);
    mkdirSync(dir3, { recursive: true });

    const ifacePath = join(dir3, "logger.ts");
    writeFileSync(ifacePath, `export interface Logger {\n  log(msg: string): void;\n}\n`);
    writeFileSync(
      join(dir3, "console-logger.ts"),
      `import { Logger } from './logger';\nexport class ConsoleLogger implements Logger { log(m: string) { console.log(m); } }\n`,
    );
    // No caller file

    const allFiles = [ifacePath, join(dir3, "console-logger.ts")];

    const result = await sprawlingAbstractionRule.run({
      cwd: dir3,
      changedFiles: allFiles,
      diffHunks: allFiles.map((f) => ({
        file: f,
        addedLines: f === ifacePath ? [1, 2, 3] : [],
      })),
    });

    expect(result.triggers).toHaveLength(0);
  });

  test("existing interface (no diff hunk on declaration) → no trigger", async () => {
    const dir4 = join(tmpdir(), `siltpoke-sa4-${Date.now()}`);
    mkdirSync(dir4, { recursive: true });

    const ifacePath = join(dir4, "service.ts");
    // Interface at lines 1-3, but diffHunks only added line 10 (some other change)
    writeFileSync(
      ifacePath,
      `export interface Service {\n  call(): void;\n}\n\n\n\n\n\n\nexport const VERSION = "1.0";\n`,
    );
    writeFileSync(
      join(dir4, "impl.ts"),
      `import { Service } from './service';\nexport class RealService implements Service { call() {} }\n`,
    );
    writeFileSync(
      join(dir4, "main.ts"),
      `import { Service } from './service';\nfunction start(s: Service) { s.call(); }\n`,
    );

    const allFiles = [ifacePath, join(dir4, "impl.ts"), join(dir4, "main.ts")];

    const result = await sprawlingAbstractionRule.run({
      cwd: dir4,
      changedFiles: allFiles,
      diffHunks: allFiles.map((f) => ({
        file: f,
        // Only mark line 10 as added — NOT the interface declaration lines 1-3
        addedLines: f === ifacePath ? [10] : [],
      })),
    });

    expect(result.triggers).toHaveLength(0);
  });
});
