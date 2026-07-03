/**
 * walker tests.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkProject, MAX_FILE_BYTES, MAX_FILES } from "../../src/repo-graph/walker";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-walker-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function seed(rel: string, content = "x"): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("walker", () => {
  test("yields source files with correct relPath + ext + lang", async () => {
    seed("src/foo.ts");
    seed("src/bar.tsx");
    seed("src/baz.js");
    seed("scripts/run.py");
    const { files } = await walkProject(projectRoot);
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toEqual([
      "scripts/run.py",
      "src/bar.tsx",
      "src/baz.js",
      "src/foo.ts",
    ]);
    const ts = files.find((f) => f.relPath === "src/foo.ts")!;
    expect(ts.ext).toBe("ts");
    expect(ts.lang).toBe("ts");
  });

  test("skips node_modules + dist + .git directories", async () => {
    seed("src/keep.ts");
    seed("node_modules/foo/index.ts");
    seed("dist/bundle.js");
    seed(".git/config", "x");
    const { files } = await walkProject(projectRoot);
    const rels = files.map((f) => f.relPath);
    expect(rels).toEqual(["src/keep.ts"]);
  });

  test("skips docs + public + tests dirs (non-source / helper-name noise)", async () => {
    seed("src/keep.ts");
    seed("docs/design/mockup/app.js");
    seed("public/static/index.js");
    seed("tests/repo-graph/helper.test.ts");
    const { files } = await walkProject(projectRoot);
    expect(files.map((f) => f.relPath)).toEqual(["src/keep.ts"]);
  });

  test("skips files larger than MAX_FILE_BYTES, records skip reason", async () => {
    const big = "x".repeat(MAX_FILE_BYTES + 100);
    seed("src/huge.ts", big);
    seed("src/small.ts", "small");
    const { files, skipped } = await walkProject(projectRoot);
    expect(files.map((f) => f.relPath)).toEqual(["src/small.ts"]);
    const skip = skipped.find((s) => s.relPath === "src/huge.ts");
    expect(skip).toBeTruthy();
    expect(skip?.reason).toBe("too_large");
    expect(skip?.size).toBeGreaterThan(MAX_FILE_BYTES);
  });

  test("skips non-source extensions with skip reason", async () => {
    seed("src/foo.ts");
    seed("README.md");
    seed("config.yaml");
    const { files, skipped } = await walkProject(projectRoot);
    expect(files.map((f) => f.relPath)).toEqual(["src/foo.ts"]);
    const md = skipped.find((s) => s.relPath === "README.md");
    expect(md?.reason).toBe("not_a_source_file");
  });

  test("skips hidden directories (those starting with '.')", async () => {
    seed("src/foo.ts");
    seed(".claude/settings.json");
    seed(".cache/x.ts");
    const { files } = await walkProject(projectRoot);
    expect(files.map((f) => f.relPath)).toEqual(["src/foo.ts"]);
  });

  test("returns empty results on missing root (no crash)", async () => {
    const ghost = join(tmpdir(), "ghost-dir-doesnotexist-12345");
    const result = await walkProject(ghost);
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("recurses nested directories", async () => {
    seed("src/a/b/c/deep.ts");
    seed("src/top.ts");
    const { files } = await walkProject(projectRoot);
    const rels = files.map((f) => f.relPath).sort();
    expect(rels).toEqual(["src/a/b/c/deep.ts", "src/top.ts"]);
  });

  // ── MAX_FILES cap (resource-exhaustion guard) ──
  test("stops at maxFiles cap + records a file_cap skip", async () => {
    for (let i = 0; i < 6; i++) seed(`src/f${i}.ts`);
    const { files, skipped } = await walkProject(projectRoot, { maxFiles: 3 });
    expect(files.length).toBe(3);
    expect(skipped.some((s) => s.reason === "file_cap")).toBe(true);
  });

  test("default MAX_FILES is a sane large cap", () => {
    expect(MAX_FILES).toBeGreaterThanOrEqual(10_000);
  });

  test("under the cap → no file_cap skip", async () => {
    seed("src/a.ts");
    seed("src/b.ts");
    const { files, skipped } = await walkProject(projectRoot, { maxFiles: 100 });
    expect(files.length).toBe(2);
    expect(skipped.some((s) => s.reason === "file_cap")).toBe(false);
  });
});
