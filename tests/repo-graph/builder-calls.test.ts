/**
 * builder wiring for call edges + coverage.
 *
 * 1. Coverage is computed + persisted into meta.json at index time (the gate
 *    is a stored value, not a per-request compute).
 * 2. RAW call edges (function-sourced) survive incremental cache reuse — the
 *    edge→file grouping must map function/class-sourced edges to their owner.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import type { RepoGraph } from "../../src/repo-graph/types";

let tmp: string;
let projectRoot: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-graph-b7-"));
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

function readGraphJson(storageDir: string): RepoGraph {
  return JSON.parse(readFileSync(join(storageDir, "graph.json"), "utf8"));
}

describe("runIndexBuild — call edges + coverage", () => {
  test("persists coverage in meta.json at index time", async () => {
    seed("src/foo.ts", `export function foo() { return 1; }`);
    seed("src/bar.ts", `import { foo } from "./foo";\nexport function bar() { return foo(); }`);

    const r = await runIndexBuild({ cwd: projectRoot, home });
    const meta = JSON.parse(readFileSync(join(r.storage_dir, "meta.json"), "utf8"));

    expect(meta.coverage).toBeDefined();
    expect(meta.coverage.totalCallsites).toBe(1);
    expect(meta.coverage.resolvedCallsites).toBe(1);
    expect(meta.coverage.pct).toBe(100);
    expect(meta.coverage.tier).toBe("green");
  });

  test("emits real calls edges into graph.json (not synthesized)", async () => {
    seed("src/foo.ts", `export function foo() { return 1; }`);
    seed("src/bar.ts", `import { foo } from "./foo";\nexport function bar() { return foo(); }`);

    const r = await runIndexBuild({ cwd: projectRoot, home });
    const graph = readGraphJson(r.storage_dir);
    const calls = graph.edges.filter((e) => e.type === "calls");
    expect(calls.some((e) => e.source === "function:src/bar.ts:bar" && e.target === "foo")).toBe(true);
    expect(r.counters.edges.calls).toBeGreaterThanOrEqual(1);
  });

  test("call edges survive an all-cached incremental rebuild", async () => {
    seed("src/foo.ts", `export function foo() { return 1; }`);
    seed("src/bar.ts", `import { foo } from "./foo";\nexport function bar() { return foo(); }`);

    const first = await runIndexBuild({ cwd: projectRoot, home });
    expect(first.counters.edges.calls).toBeGreaterThanOrEqual(1);

    const second = await runIndexBuild({ cwd: projectRoot, home });
    expect(second.counters.files_cached).toBe(2);
    expect(second.counters.files_walked).toBe(0);

    const graph = readGraphJson(second.storage_dir);
    const calls = graph.edges.filter((e) => e.type === "calls");
    expect(calls.some((e) => e.source === "function:src/bar.ts:bar" && e.target === "foo")).toBe(true);
  });
});
