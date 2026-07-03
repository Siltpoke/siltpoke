/**
 * End-to-end regression for `/siltpoke-index`.
 *
 * Coverage map:
 *   - slash markdown file points at the canonical CLI command
 *   - bare CLI runs incremental build via process spawn
 *   - `--force` rebuilds from scratch (cached == 0)
 *   - `--json` envelope parseable + shape is correct
 *   - 4 artifact files land at canonical path
 *   - meta.json on disk carries the expected fields
 *   - zero-change re-run = full cache hit
 *   - single-file change re-walks only that file
 *   - node_modules / dist / hidden dir leave no node in graph
 *   - non-source extensions counted in `not_a_source_file`
 *   - 1MB cap increments `too_large`
 *   - `function constructor` resolves to a real node (write-time defense)
 *   - two projects under different cwds produce two proj-hash dirs
 *     with zero path overlap
 *   - cold build duration on synthetic 5-file project < 30s
 *   - graph.json on synthetic project < 5MB
 *
 * Uses `Bun.spawn` to exercise the actual CLI binary (not the internal
 * `runIndexBuild` API), so this suite catches regressions in argv parsing,
 * `process.exit` codes, stdout framing, and slash → bash routing.
 *
 * Storage isolated per-test via `SILTPOKE_HOME` env override.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli", "index-repo.ts");
const SLASH_PATH = join(REPO_ROOT, ".claude-plugin", "commands", "siltpoke-index.md");

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface JsonEnvelope {
  project_root: string;
  proj_hash: string;
  storage_dir: string;
  duration_ms: number;
  counters: {
    files_walked: number;
    files_cached: number;
    nodes: { file: number; function: number; class: number; module: number; symbol: number };
    edges: { imports: number; calls: number; contains: number };
    skipped: { tree_sitter_failed: number; too_large: number; not_a_source_file: number; file_cap: number };
  };
}

async function runCli(args: string[], cwd: string, siltpokeHome: string): Promise<CliRunResult> {
  const start = performance.now();
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, SILTPOKE_HOME: siltpokeHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr, durationMs: performance.now() - start };
}

async function runJson(args: string[], cwd: string, siltpokeHome: string): Promise<{ result: CliRunResult; envelope: JsonEnvelope }> {
  const result = await runCli(["--json", ...args], cwd, siltpokeHome);
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as JsonEnvelope;
  return { result, envelope };
}

let tmp: string;
let projectRoot: string;
let siltpokeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-e2e-index-"));
  projectRoot = join(tmp, "proj");
  siltpokeHome = join(tmp, "siltpoke-home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(siltpokeHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("slash command markdown sanity", () => {
  test("siltpoke-index.md points at canonical CLI path", () => {
    expect(existsSync(SLASH_PATH)).toBe(true);
    const md = readFileSync(SLASH_PATH, "utf8");
    expect(md).toContain("src/cli/index-repo.ts");
    expect(md).toMatch(/bun .*src\/cli\/index-repo\.ts \$ARGUMENTS/);
    expect(md).toContain("argument-hint: [--force]");
  });
});

describe("bare CLI incremental + artifacts + meta shape", () => {
  test("bare CLI on fresh project writes 4 artifacts + meta carries the expected fields", async () => {
    seed("src/foo.ts", "export function foo() { return 1; }\n");
    seed("src/bar.ts", "import { foo } from './foo';\nexport function bar() { return foo(); }\n");

    const { envelope } = await runJson([], projectRoot, siltpokeHome);

    expect(envelope.counters.files_walked).toBe(2);
    expect(envelope.counters.files_cached).toBe(0);
    expect(envelope.counters.nodes.file).toBe(2);
    expect(envelope.counters.nodes.function).toBe(2);

    const storageDir = envelope.storage_dir;
    for (const name of ["graph.json", "queryIndex.json", "fingerprints.json", "meta.json"]) {
      expect(existsSync(join(storageDir, name))).toBe(true);
    }

    const meta = JSON.parse(readFileSync(join(storageDir, "meta.json"), "utf8"));
    expect(meta.schemaVersion).toBe(1);
    expect(meta.project_root).toBe(realpathSync(projectRoot));
    expect(meta.proj_hash).toMatch(/^[a-f0-9]{12}$/);
    expect(typeof meta.last_indexed_ts).toBe("string");
    expect(meta.last_indexed_ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof meta.build_duration_ms).toBe("number");
    expect(meta.counters.nodes).toBeDefined();
    expect(meta.counters.edges).toBeDefined();
    expect(meta.counters.skipped).toBeDefined();
  });
});

describe("--force re-walks every file", () => {
  test("after a clean build, --force returns files_cached == 0", async () => {
    seed("src/a.ts", "export const a = 1;\n");
    seed("src/b.ts", "export const b = 2;\n");

    await runJson([], projectRoot, siltpokeHome);
    const { envelope } = await runJson(["--force"], projectRoot, siltpokeHome);

    expect(envelope.counters.files_walked).toBe(2);
    expect(envelope.counters.files_cached).toBe(0);
  });
});

describe("--json envelope shape", () => {
  test("--json emits a single parseable object with the expected keys", async () => {
    seed("src/foo.ts", "export function foo() {}\n");
    const { result, envelope } = await runJson([], projectRoot, siltpokeHome);

    expect(result.stdout.trim().startsWith("{")).toBe(true);

    for (const key of ["project_root", "proj_hash", "storage_dir", "duration_ms", "counters"]) {
      expect(envelope).toHaveProperty(key);
    }
    for (const key of ["files_walked", "files_cached", "nodes", "edges", "skipped"]) {
      expect(envelope.counters).toHaveProperty(key);
    }
    for (const key of ["file", "function", "class", "module", "symbol"]) {
      expect(envelope.counters.nodes).toHaveProperty(key);
    }
    for (const key of ["imports", "calls", "contains"]) {
      expect(envelope.counters.edges).toHaveProperty(key);
    }
    for (const key of ["tree_sitter_failed", "too_large", "not_a_source_file"]) {
      expect(envelope.counters.skipped).toHaveProperty(key);
    }
  });
});

describe("zero-change re-run is full cache hit", () => {
  test("second bare CLI call walks 0 / caches all", async () => {
    seed("src/foo.ts", "export function foo() {}\n");
    seed("src/bar.ts", "export function bar() {}\n");

    const { envelope: first } = await runJson([], projectRoot, siltpokeHome);
    expect(first.counters.files_walked).toBe(2);

    const { envelope: second } = await runJson([], projectRoot, siltpokeHome);
    expect(second.counters.files_walked).toBe(0);
    expect(second.counters.files_cached).toBe(2);
  });
});

describe("single-file change re-walks only that file", () => {
  test("editing one file → walked 1, cached n-1", async () => {
    seed("src/foo.ts", "export function foo() {}\n");
    seed("src/bar.ts", "export function bar() {}\n");
    seed("src/baz.ts", "export function baz() {}\n");

    await runJson([], projectRoot, siltpokeHome);

    seed("src/bar.ts", "export function bar() {}\nexport function barNew() {}\n");

    const { envelope } = await runJson([], projectRoot, siltpokeHome);
    expect(envelope.counters.files_walked).toBe(1);
    expect(envelope.counters.files_cached).toBe(2);
  });
});

describe("skip list excludes node_modules + hidden + dist", () => {
  test("node_modules + dist + .hidden paths leave no nodes in graph", async () => {
    seed("src/keep.ts", "export const keep = 1;\n");
    seed("node_modules/pkg/index.ts", "export const skip1 = 1;\n");
    seed("dist/build.ts", "export const skip2 = 1;\n");
    seed(".hidden/secret.ts", "export const skip3 = 1;\n");

    const { envelope } = await runJson([], projectRoot, siltpokeHome);
    expect(envelope.counters.files_walked).toBe(1);

    const graph = JSON.parse(readFileSync(join(envelope.storage_dir, "graph.json"), "utf8"));
    const paths = new Set<string>(graph.nodes.map((n: { path: string }) => n.path));
    for (const p of paths) {
      expect(p).not.toContain("node_modules");
      expect(p).not.toContain("dist/");
      expect(p).not.toContain(".hidden");
    }
  });
});

describe("non-source extensions counted in not_a_source_file", () => {
  test(".md / .json / .go skipped + counter > 0", async () => {
    seed("src/keep.ts", "export const a = 1;\n");
    seed("README.md", "# heading\n");
    seed("data.json", '{"k":1}\n');
    seed("script.go", "package main\n");

    const { envelope } = await runJson([], projectRoot, siltpokeHome);
    expect(envelope.counters.files_walked).toBe(1);
    expect(envelope.counters.skipped.not_a_source_file).toBeGreaterThanOrEqual(3);
  });
});

describe("1MB file cap", () => {
  test("file > 1MB skipped + too_large counter increments", async () => {
    seed("src/small.ts", "export const small = 1;\n");
    const bigContent = `// padding\n${"x".repeat(1_100_000)}\nexport const big = 1;\n`;
    seed("src/big.ts", bigContent);

    const { envelope } = await runJson([], projectRoot, siltpokeHome);
    expect(envelope.counters.skipped.too_large).toBeGreaterThanOrEqual(1);
    expect(envelope.counters.files_walked).toBe(1);
  });
});

describe("prototype-pollution-safe query index (write-time defense)", () => {
  test("function named `constructor` resolves to a real node id", async () => {
    seed(
      "src/proto.ts",
      [
        "export function constructor() { return 1; }",
        "export function __proto__() { return 2; }",
        "export function hasOwnProperty() { return 3; }",
        "export function normal() { return 4; }",
        "",
      ].join("\n"),
    );

    const { envelope } = await runJson([], projectRoot, siltpokeHome);
    expect(envelope.counters.nodes.function).toBe(4);

    const qi = JSON.parse(readFileSync(join(envelope.storage_dir, "queryIndex.json"), "utf8"));

    for (const name of ["constructor", "__proto__", "hasOwnProperty", "normal"]) {
      const matches = qi.name_to_node_ids[name];
      expect(Array.isArray(matches)).toBe(true);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      const id = matches[0];
      expect(typeof id).toBe("string");
      expect(id).toContain("function:");
      expect(id).toContain(name);
    }
  });
});

describe("cross-repo isolation", () => {
  test("two projects under different cwds write to different proj-hash dirs with zero path overlap", async () => {
    const projectB = join(tmp, "proj-b");
    mkdirSync(projectB, { recursive: true });

    writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(projectB, "b.ts"), "export const b = 2;\n");

    const { envelope: envA } = await runJson([], projectRoot, siltpokeHome);
    const { envelope: envB } = await runJson([], projectB, siltpokeHome);

    expect(envA.proj_hash).not.toBe(envB.proj_hash);
    expect(envA.storage_dir).not.toBe(envB.storage_dir);

    const graphA = JSON.parse(readFileSync(join(envA.storage_dir, "graph.json"), "utf8"));
    const graphB = JSON.parse(readFileSync(join(envB.storage_dir, "graph.json"), "utf8"));
    const pathsA = new Set<string>(graphA.nodes.map((n: { path: string }) => n.path));
    const pathsB = new Set<string>(graphB.nodes.map((n: { path: string }) => n.path));

    let overlap = 0;
    for (const p of pathsA) if (pathsB.has(p)) overlap++;
    expect(overlap).toBe(0);
  });
});

describe("synthetic performance gates", () => {
  test("cold build duration < 30s + graph.json < 5MB on 5-file project", async () => {
    for (let i = 0; i < 5; i++) {
      seed(`src/m${i}.ts`, `export function m${i}() { return ${i}; }\n`);
    }
    const { result, envelope } = await runJson(["--force"], projectRoot, siltpokeHome);

    expect(result.durationMs).toBeLessThan(30_000);
    expect(envelope.duration_ms).toBeLessThan(30_000);

    const graphBytes = readFileSync(join(envelope.storage_dir, "graph.json")).byteLength;
    expect(graphBytes).toBeLessThan(5 * 1024 * 1024);
  });
});
