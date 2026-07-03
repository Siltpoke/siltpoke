import { describe, test, expect } from "bun:test";
import { defensiveOverreachRule } from "../../../../src/critic/rubric/tier2/defensive-overreach";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-do-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("defensive-overreach rule", () => {
  test("TS: try/catch around JSON.parse with silent console.log catch → trigger HIGH", async () => {
    const src = `
function parse(x: string) {
  try {
    return JSON.parse(x);
  } catch (e) {
    console.log(e);
  }
}
`.trim();
    const path = writeFile("silent-catch.ts", src);
    const result = await defensiveOverreachRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    const t = result.triggers[0];
    expect(t.severity).toBe("high");
    expect(t.rule_id).toBe("defensive-overreach");
  });

  test("TS: try/catch around await fetch → no trigger (has I/O)", async () => {
    const src = `
async function load(url: string) {
  try {
    const res = await fetch(url);
    return res.json();
  } catch (e) {
    console.log(e);
  }
}
`.trim();
    const path = writeFile("fetch-catch.ts", src);
    const result = await defensiveOverreachRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("TS: try/catch around JSON.parse that rethrows → no trigger", async () => {
    const src = `
function parse(x: string) {
  try {
    return JSON.parse(x);
  } catch (e) {
    console.log(e);
    throw e;
  }
}
`.trim();
    const path = writeFile("rethrow-catch.ts", src);
    const result = await defensiveOverreachRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("Python: try arithmetic with pass → trigger HIGH", async () => {
    const src = `
def add(a, b):
    try:
        result = a + b
    except Exception:
        pass
`.trim();
    const path = writeFile("silent-pass.py", src);
    const result = await defensiveOverreachRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("high");
  });

  test("Python: try open(f) with logger → no trigger (I/O present)", async () => {
    const src = `
def read_file(f):
    try:
        with open(f) as fh:
            return fh.read()
    except Exception as e:
        logging.error(e)
`.trim();
    const path = writeFile("open-catch.py", src);
    const result = await defensiveOverreachRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });
});
