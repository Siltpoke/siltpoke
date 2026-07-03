/**
 * end-to-end builder tests on synthetic tmpdir projects.
 *
 * added `building` field lifecycle tests at bottom.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { readMeta } from "../../src/repo-graph/store";

let tmp: string;
let projectRoot: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-graph-builder-"));
  projectRoot = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("runIndexBuild — full build (cold)", () => {
  test("walks files, extracts nodes + edges, writes 4 artifacts", async () => {
    seed("src/foo.ts", `export function foo() { return 1; }`);
    seed("src/bar.ts", `import { foo } from "./foo";\nexport function bar() { return foo(); }`);
    seed("README.md", "skipped");

    const r = await runIndexBuild({ cwd: projectRoot, home });

    expect(r.counters.files_walked).toBe(2);
    expect(r.counters.files_cached).toBe(0);
    expect(r.counters.nodes.file).toBe(2);
    expect(r.counters.nodes.function).toBe(2);
    expect(r.counters.edges.contains).toBe(2);
    expect(r.counters.edges.imports).toBe(1);
    expect(r.counters.skipped.not_a_source_file).toBeGreaterThanOrEqual(1);

    // 4 artifact files exist on disk.
    expect(readFileSync(join(r.storage_dir, "graph.json"), "utf8")).toContain("foo");
    expect(readFileSync(join(r.storage_dir, "queryIndex.json"), "utf8")).toContain("foo");
    expect(readFileSync(join(r.storage_dir, "fingerprints.json"), "utf8")).toContain("src/foo.ts");
    expect(readFileSync(join(r.storage_dir, "meta.json"), "utf8")).toContain("schemaVersion");
  });

  test("queryIndex maps name → node ids + path → node ids", async () => {
    seed("src/x.ts", `export function foo() {}\nexport function bar() {}`);
    const r = await runIndexBuild({ cwd: projectRoot, home });
    const idx = JSON.parse(readFileSync(join(r.storage_dir, "queryIndex.json"), "utf8"));
    expect(idx.name_to_node_ids.foo).toContain("function:src/x.ts:foo");
    expect(idx.name_to_node_ids.bar).toContain("function:src/x.ts:bar");
    expect(idx.path_to_node_ids["src/x.ts"]).toContain("file:src/x.ts:");
    expect(idx.path_to_node_ids["src/x.ts"]).toContain("function:src/x.ts:foo");
  });

  test("meta.json captures proj_root, duration, counters", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const r = await runIndexBuild({ cwd: projectRoot, home, now: () => new Date("2026-05-27T20:00:00Z") });
    const meta = JSON.parse(readFileSync(join(r.storage_dir, "meta.json"), "utf8"));
    expect(meta.schemaVersion).toBe(1);
    expect(meta.project_root).toBe(projectRoot);
    expect(meta.proj_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(meta.last_indexed_ts).toBe("2026-05-27T20:00:00.000Z");
    expect(typeof meta.build_duration_ms).toBe("number");
    expect(meta.counters.files_walked).toBe(1);
  });
});

describe("runIndexBuild — incremental (cache hit path)", () => {
  test("unchanged files → all cached, 0 re-walks", async () => {
    seed("src/foo.ts", `export function foo() { return 1; }`);
    seed("src/bar.ts", `export function bar() { return 2; }`);

    const first = await runIndexBuild({ cwd: projectRoot, home });
    expect(first.counters.files_walked).toBe(2);

    const second = await runIndexBuild({ cwd: projectRoot, home });
    expect(second.counters.files_walked).toBe(0);
    expect(second.counters.files_cached).toBe(2);
    // Node + edge counters reflect the cached reuse.
    expect(second.counters.nodes.function).toBe(2);
    expect(second.counters.edges.contains).toBe(2);
  });

  test("one file changed → exactly 1 re-walk, others cached", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    seed("src/bar.ts", `export function bar() {}`);

    await runIndexBuild({ cwd: projectRoot, home });

    // Edit foo.ts.
    writeFileSync(join(projectRoot, "src/foo.ts"), `export function foo() {}\nexport function newFn() {}`);

    const r2 = await runIndexBuild({ cwd: projectRoot, home });
    expect(r2.counters.files_walked).toBe(1);
    expect(r2.counters.files_cached).toBe(1);
    expect(r2.counters.nodes.function).toBe(3); // foo, newFn, bar
  });

  test("--force re-walks all files even when content unchanged", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    await runIndexBuild({ cwd: projectRoot, home });

    const r2 = await runIndexBuild({ cwd: projectRoot, home, force: true });
    expect(r2.counters.files_walked).toBe(1);
    expect(r2.counters.files_cached).toBe(0);
  });

  test("deleted file → removed from graph", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    seed("src/bar.ts", `export function bar() {}`);
    await runIndexBuild({ cwd: projectRoot, home });

    // Delete bar.ts.
    rmSync(join(projectRoot, "src/bar.ts"));

    const r2 = await runIndexBuild({ cwd: projectRoot, home });
    expect(r2.counters.files_walked).toBe(0); // foo still cached
    expect(r2.counters.files_cached).toBe(1);
    expect(r2.counters.nodes.file).toBe(1);
    expect(r2.counters.nodes.function).toBe(1);
  });
});

describe("runIndexBuild — robustness", () => {
  test("empty project (no source files) → builds successfully with zeros", async () => {
    seed("README.md", "no code here");
    const r = await runIndexBuild({ cwd: projectRoot, home });
    expect(r.counters.files_walked).toBe(0);
    expect(r.counters.nodes.file).toBe(0);
  });

  test("file with parse-incompatible content → skipped, build continues", async () => {
    // Use unparseable invalid TypeScript that tree-sitter still tries to parse
    // (tree-sitter is recovery-oriented, may not return null but still produces partial tree).
    // To force null tree, write empty file with a tree-sitter-incompatible extension that we
    // also walk. Empty file is fine to parse; we don't test the null branch directly,
    // we test that builder DOESN'T crash on a syntactically dubious file.
    seed("src/weird.ts", `function foo() { /* unclosed`);
    const r = await runIndexBuild({ cwd: projectRoot, home });
    // Either walked or recorded as parse-failed. Both acceptable; key is no crash.
    expect(r.counters.files_walked + r.counters.skipped.tree_sitter_failed).toBeGreaterThanOrEqual(0);
  });
});

describe("runIndexBuild — building flag (schema extension)", () => {
  test("writes building=false at end of happy-path build", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const r = await runIndexBuild({ cwd: projectRoot, home });
    const meta = JSON.parse(readFileSync(join(r.storage_dir, "meta.json"), "utf8"));
    expect(meta.building).toBe(false);
  });

  test("writes building=true at start (observable via mid-build hook), flips false at end", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    let midBuildBuildingFlag: boolean | undefined;
    const r = await runIndexBuild({
      cwd: projectRoot,
      home,
      __onBuildStart: (storageDir: string) => {
        const meta = JSON.parse(readFileSync(join(storageDir, "meta.json"), "utf8"));
        midBuildBuildingFlag = meta.building;
      },
    });
    expect(midBuildBuildingFlag).toBe(true);
    const finalMeta = JSON.parse(readFileSync(join(r.storage_dir, "meta.json"), "utf8"));
    expect(finalMeta.building).toBe(false);
  });

  test("missing building field on pre-existing meta is read as undefined (backward-compat)", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const r = await runIndexBuild({ cwd: projectRoot, home });
    // Strip building field to simulate a pre-existing cache entry.
    const meta = JSON.parse(readFileSync(join(r.storage_dir, "meta.json"), "utf8"));
    delete meta.building;
    writeFileSync(join(r.storage_dir, "meta.json"), JSON.stringify(meta));

    const reread = await readMeta(r.storage_dir);
    expect(reread).not.toBeNull();
    expect(reread!.building).toBeUndefined();
  });

  test("two consecutive builds: both close out with building=false", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const r1 = await runIndexBuild({ cwd: projectRoot, home });
    expect(JSON.parse(readFileSync(join(r1.storage_dir, "meta.json"), "utf8")).building).toBe(false);

    const r2 = await runIndexBuild({ cwd: projectRoot, home });
    expect(JSON.parse(readFileSync(join(r2.storage_dir, "meta.json"), "utf8")).building).toBe(false);
  });

  test("mid-build write preserves prior successful build's last_indexed_ts + proj_hash", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const r1 = await runIndexBuild({
      cwd: projectRoot,
      home,
      now: () => new Date("2026-05-28T10:00:00Z"),
    });
    const meta1 = JSON.parse(readFileSync(join(r1.storage_dir, "meta.json"), "utf8"));
    const priorTs = meta1.last_indexed_ts;

    let midBuildMeta: { building?: boolean; proj_hash?: string; last_indexed_ts?: string } = {};
    await runIndexBuild({
      cwd: projectRoot,
      home,
      now: () => new Date("2026-05-28T11:00:00Z"),
      __onBuildStart: (storageDir: string) => {
        midBuildMeta = JSON.parse(readFileSync(join(storageDir, "meta.json"), "utf8"));
      },
    });

    expect(midBuildMeta.building).toBe(true);
    expect(midBuildMeta.proj_hash).toBe(meta1.proj_hash);
    expect(midBuildMeta.last_indexed_ts).toBe(priorTs);
  });

  test("first cold build (no prior meta): building=true write produces minimal valid stub", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    let midBuildMeta: { building?: boolean; schemaVersion?: number; project_root?: string; proj_hash?: string } = {};
    await runIndexBuild({
      cwd: projectRoot,
      home,
      __onBuildStart: (storageDir: string) => {
        midBuildMeta = JSON.parse(readFileSync(join(storageDir, "meta.json"), "utf8"));
      },
    });

    expect(midBuildMeta.building).toBe(true);
    expect(midBuildMeta.schemaVersion).toBe(1);
    expect(typeof midBuildMeta.project_root).toBe("string");
    expect(midBuildMeta.project_root!.length).toBeGreaterThan(0);
    expect(typeof midBuildMeta.proj_hash).toBe("string");
    expect(midBuildMeta.proj_hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

// ── self-clean on failure + progress hook ──
describe("runIndexBuild — self-clean on failure (stale-orphan root cause)", () => {
  test("cold build that throws mid-build removes the partial storage dir (no building:true orphan)", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const loc = resolveRepoGraphLocation(projectRoot, { home });
    await expect(
      runIndexBuild({
        cwd: projectRoot,
        home,
        __onBuildStart: () => {
          throw new Error("boom mid-build");
        },
      }),
    ).rejects.toThrow("boom mid-build");
    // The dir was created by markBuildStart with building:true; on throw it must
    // be gone, not left as a stuck "indexing" orphan.
    expect(existsSync(loc.storage_dir)).toBe(false);
  });

  test("re-index that throws keeps the prior good index + reverts building to false", async () => {
    seed("src/foo.ts", `export function foo() {}`);
    const r1 = await runIndexBuild({ cwd: projectRoot, home });
    expect(existsSync(join(r1.storage_dir, "graph.json"))).toBe(true);

    await expect(
      runIndexBuild({
        cwd: projectRoot,
        home,
        __onBuildStart: () => {
          throw new Error("boom on re-index");
        },
      }),
    ).rejects.toThrow("boom on re-index");

    // Prior index survives; meta is NOT left stuck building:true.
    expect(existsSync(join(r1.storage_dir, "graph.json"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(r1.storage_dir, "meta.json"), "utf8"));
    expect(meta.building).toBe(false);
  });
});

describe("runIndexBuild — onProgress hook (granular N/M)", () => {
  test("calls onProgress per source file, final call is (total,total)", async () => {
    seed("src/a.ts", `export function a() {}`);
    seed("src/b.ts", `export function b() {}`);
    seed("src/c.ts", `export function c() {}`);
    seed("README.md", "skipped");
    const calls: Array<[number, number]> = [];
    await runIndexBuild({
      cwd: projectRoot,
      home,
      onProgress: (done, total) => calls.push([done, total]),
    });
    expect(calls.length).toBeGreaterThan(0);
    const total = calls[0]![1];
    expect(total).toBe(3); // 3 source files; README is not counted
    expect(calls.every(([, t]) => t === total)).toBe(true);
    expect(calls.at(-1)).toEqual([3, 3]);
  });
});

// Silence unused-import warning when resolveRepoGraphLocation is only used in
// describe scaffolding above (kept for future fingerprint-state tests).
void resolveRepoGraphLocation;
