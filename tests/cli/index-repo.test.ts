/**
 * CLI tests for index-repo (flag parsing + output formats).
 */
import { test, expect, describe } from "bun:test";
import { parseArgs, formatHuman, formatJson } from "../../src/cli/index-repo";

const sampleResult = {
  project_root: "/tmp/proj",
  proj_hash: "abc123def456",
  storage_dir: "/home/.siltpoke/repo-memory/abc123def456",
  duration_ms: 4200,
  counters: {
    files_walked: 49,
    files_cached: 293,
    nodes: { file: 340, function: 612, class: 421, module: 0, symbol: 443 },
    edges: { imports: 891, calls: 0, contains: 783 },
    skipped: { tree_sitter_failed: 3, too_large: 1, not_a_source_file: 12, file_cap: 0 },
  },
} as const;

describe("parseArgs", () => {
  test("--force flag", () => {
    expect(parseArgs(["--force"])).toEqual({ force: true, json: false, progress: false });
  });
  test("--json flag", () => {
    expect(parseArgs(["--json"])).toEqual({ force: false, json: true, progress: false });
  });
  test("both flags", () => {
    expect(parseArgs(["--force", "--json"])).toEqual({ force: true, json: true, progress: false });
  });
  test("no flags", () => {
    expect(parseArgs([])).toEqual({ force: false, json: false, progress: false });
  });
  test("--progress flag", () => {
    expect(parseArgs(["--progress"])).toEqual({ force: false, json: false, progress: true });
  });
});

describe("formatters", () => {
  test("formatHuman includes file count + node count + duration", () => {
    const out = formatHuman(sampleResult);
    expect(out).toContain("/tmp/proj");
    expect(out).toContain("49 files");
    expect(out).toContain("293 cached");
    expect(out).toContain("612 functions");
    expect(out).toContain("783 contains");
    expect(out).toContain("4.20s");
    expect(out).toContain("Graph saved to");
  });

  test("formatHuman omits skipped line when nothing skipped", () => {
    const result = {
      ...sampleResult,
      counters: {
        ...sampleResult.counters,
        skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      },
    };
    const out = formatHuman(result);
    expect(out).not.toContain("skipped");
  });

  test("formatJson emits valid structured output", () => {
    const out = formatJson(sampleResult);
    const parsed = JSON.parse(out);
    expect(parsed.project_root).toBe("/tmp/proj");
    expect(parsed.proj_hash).toBe("abc123def456");
    expect(parsed.counters.nodes.function).toBe(612);
  });
});
