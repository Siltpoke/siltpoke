import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRepoMemoryIndex, loadIndex } from "../../src/repo-memory/index-builder.ts";

describe("index-builder", () => {
  let tmp: string;
  let cwd: string;
  let memoryDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-idx-test-"));
    cwd = join(tmp, "project");
    memoryDir = join(tmp, "memory");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): void {
    const full = join(cwd, relativePath);
    mkdirSync(join(cwd, relativePath.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(full, content);
  }

  test("builds index with correct file count", async () => {
    writeFile("src/foo.ts", "export const foo = 1;");
    writeFile("src/bar.ts", "export const bar = 2;");
    writeFile("src/baz.ts", "export const baz = 3;");

    const index = await buildRepoMemoryIndex({ cwd, memoryDir, pattern: "src/**/*.ts" });
    expect(index.files).toHaveLength(3);
    expect(index.files.every((f) => f.sha256.length === 64)).toBe(true);
    expect(index.built_at).toBeTruthy();
  });

  test("detects kebab-case convention when 80%+ of files qualify", async () => {
    // 5 kebab files + 0 non-kebab = 100% → convention detected
    for (const name of ["foo-bar.ts", "baz-qux.ts", "my-file.ts", "some-thing.ts", "another-one.ts"]) {
      writeFile(`src/${name}`, "export const x = 1;");
    }
    const index = await buildRepoMemoryIndex({ cwd, memoryDir, pattern: "src/**/*.ts" });
    const convention = index.conventions.find((c) => c.id === "naming-kebab-case-files");
    expect(convention).toBeDefined();
    expect(convention?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("no convention when fewer than 5 files", async () => {
    writeFile("src/foo-bar.ts", "export const x = 1;");
    writeFile("src/baz-qux.ts", "export const y = 2;");
    const index = await buildRepoMemoryIndex({ cwd, memoryDir, pattern: "src/**/*.ts" });
    expect(index.conventions).toHaveLength(0);
  });

  test("rebuild is idempotent — same file count on second run", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFile(`src/${name}`, "export const v = 1;");
    }
    await buildRepoMemoryIndex({ cwd, memoryDir, pattern: "src/**/*.ts" });
    const index2 = await buildRepoMemoryIndex({ cwd, memoryDir, pattern: "src/**/*.ts" });
    expect(index2.files).toHaveLength(3);
  });

  test("loadIndex returns null when index.json missing", async () => {
    const result = await loadIndex(join(tmp, "nonexistent"));
    expect(result).toBeNull();
  });

  test("loadIndex returns saved index after build", async () => {
    writeFile("src/foo.ts", "export const foo = 1;");
    await buildRepoMemoryIndex({ cwd, memoryDir, pattern: "src/**/*.ts" });
    const loaded = await loadIndex(memoryDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.files).toHaveLength(1);
  });
});
