import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeInconsistencyRule } from "../../src/repo-memory/inconsistency-detector.ts";
import type { RepoMemoryIndex } from "../../src/repo-memory/types.ts";

describe("inconsistency-detector", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-incon-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeIndex(_dir: string, fileNames: string[]): RepoMemoryIndex {
    return {
      built_at: new Date().toISOString(),
      files: fileNames.map((name) => ({
        path: `src/critic/${name}`,
        sha256: "a".repeat(64),
        lang: "ts",
        summary_path: `${"a".repeat(64)}.md`,
      })),
      conventions: [],
    };
  }

  test("default export in dir where 80%+ use named-const → LOW trigger", async () => {
    const dir = join(tmp, "src", "critic");
    mkdirSync(dir, { recursive: true });
    const newFile = join(dir, "my-rule.ts");
    writeFileSync(newFile, `export default function myRule() {}\n`);

    // 10 existing kebab-case TS files in same dir
    const names = Array.from({ length: 10 }, (_, i) => `rule-${i}.ts`);
    const index = makeIndex(dir, names);

    const rule = makeInconsistencyRule(async () => index);
    const result = await rule.run({ cwd: tmp, changedFiles: [newFile], diffHunks: [] });

    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].severity).toBe("low");
    expect(result.triggers[0].rule_id).toBe("repo-memory-inconsistency");
  });

  test("no index → no triggers", async () => {
    const dir = join(tmp, "src");
    mkdirSync(dir, { recursive: true });
    const newFile = join(dir, "my-rule.ts");
    writeFileSync(newFile, `export default function myRule() {}\n`);

    const rule = makeInconsistencyRule(async () => null);
    const result = await rule.run({ cwd: tmp, changedFiles: [newFile], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
  });

  test("new file uses named-const export (matching pattern) → no trigger", async () => {
    const dir = join(tmp, "src", "critic");
    mkdirSync(dir, { recursive: true });
    const newFile = join(dir, "my-rule.ts");
    writeFileSync(newFile, `export const myRule = { id: "my-rule" };\n`);

    const names = Array.from({ length: 10 }, (_, i) => `rule-${i}.ts`);
    const index = makeIndex(dir, names);

    const rule = makeInconsistencyRule(async () => index);
    const result = await rule.run({ cwd: tmp, changedFiles: [newFile], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
  });

  test("fewer than 3 similar files → no trigger (insufficient signal)", async () => {
    const dir = join(tmp, "src", "critic");
    mkdirSync(dir, { recursive: true });
    const newFile = join(dir, "my-rule.ts");
    writeFileSync(newFile, `export default function myRule() {}\n`);

    // Only 2 similar files — not enough signal
    const index = makeIndex(dir, ["rule-0.ts", "rule-1.ts"]);

    const rule = makeInconsistencyRule(async () => index);
    const result = await rule.run({ cwd: tmp, changedFiles: [newFile], diffHunks: [] });
    expect(result.triggers).toHaveLength(0);
  });
});
