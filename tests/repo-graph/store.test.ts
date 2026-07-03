/**
 * store.ts round-trip tests.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readGraph,
  writeGraph,
  readQueryIndex,
  writeQueryIndex,
  readFingerprints,
  writeFingerprints,
  readMeta,
  writeMeta,
} from "../../src/repo-graph/store";
import {
  emptyFingerprints,
  emptyGraph,
  emptyQueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
} from "../../src/repo-graph/types";

let tmp: string;
let storageDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-graph-store-"));
  storageDir = join(tmp, "repo-memory", "abc123def456");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("graph store — round-trip", () => {
  test("readGraph returns empty when file is missing", async () => {
    const g = await readGraph(storageDir);
    expect(g).toEqual(emptyGraph());
  });

  test("writeGraph + readGraph round-trips nodes + edges", async () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "file:src/x.ts:", type: "file", name: "x.ts", path: "src/x.ts", lineRange: [1, 100] },
        { id: "function:src/x.ts:foo", type: "function", name: "foo", path: "src/x.ts", lineRange: [5, 20], complexity: 3 },
      ],
      edges: [
        { id: "file:src/x.ts:::contains::function:src/x.ts:foo", source: "file:src/x.ts:", target: "function:src/x.ts:foo", type: "contains", weight: 1 },
      ],
    };
    await writeGraph(storageDir, graph);
    expect(existsSync(join(storageDir, "graph.json"))).toBe(true);
    const round = await readGraph(storageDir);
    expect(round).toEqual(graph);
  });

  test("readGraph returns empty on corrupt JSON", async () => {
    mkdirSync(storageDir, { recursive: true });
    const fs = await import("node:fs");
    fs.writeFileSync(join(storageDir, "graph.json"), "{ broken");
    const g = await readGraph(storageDir);
    expect(g).toEqual(emptyGraph());
  });

  test("readGraph returns empty when schemaVersion mismatches", async () => {
    await writeGraph(storageDir, { schemaVersion: 99 as unknown as 1, nodes: [], edges: [] });
    const g = await readGraph(storageDir);
    expect(g).toEqual(emptyGraph());
  });
});

describe("queryIndex store — round-trip", () => {
  test("empty when missing", async () => {
    expect(await readQueryIndex(storageDir)).toEqual(emptyQueryIndex());
  });

  test("write + read", async () => {
    const idx = {
      schemaVersion: 1 as const,
      name_to_node_ids: { foo: ["function:src/x.ts:foo"] },
      path_to_node_ids: { "src/x.ts": ["file:src/x.ts:", "function:src/x.ts:foo"] },
    };
    await writeQueryIndex(storageDir, idx);
    expect(await readQueryIndex(storageDir)).toEqual(idx);
  });
});

describe("fingerprints store — round-trip", () => {
  test("empty when missing", async () => {
    expect(await readFingerprints(storageDir)).toEqual(emptyFingerprints());
  });

  test("write + read preserves per-file sha + ast sig", async () => {
    const fp = {
      schemaVersion: 1 as const,
      files: {
        "src/x.ts": { content_sha256: "abc", ast_sig: "deadbeef" },
        "src/y.ts": { content_sha256: "def", ast_sig: "cafebabe" },
      },
    };
    await writeFingerprints(storageDir, fp);
    expect(await readFingerprints(storageDir)).toEqual(fp);
  });
});

describe("meta store — round-trip", () => {
  test("null when missing", async () => {
    expect(await readMeta(storageDir)).toBeNull();
  });

  test("write + read", async () => {
    const meta: RepoGraphMeta = {
      schemaVersion: 1,
      project_root: "/path/to/proj",
      proj_hash: "abc123def456",
      last_indexed_ts: "2026-05-27T20:00:00Z",
      build_duration_ms: 4200,
      counters: {
        files_walked: 49,
        files_cached: 293,
        nodes: { file: 340, function: 612, class: 421, module: 18, symbol: 443 },
        edges: { imports: 891, calls: 2103, contains: 783 },
        skipped: { tree_sitter_failed: 3, too_large: 1, not_a_source_file: 0, file_cap: 0 },
      },
    };
    await writeMeta(storageDir, meta);
    expect(await readMeta(storageDir)).toEqual(meta);
  });

  test("null on wrong schemaVersion", async () => {
    await writeMeta(storageDir, { ...({ schemaVersion: 9 } as unknown as RepoGraphMeta) });
    expect(await readMeta(storageDir)).toBeNull();
  });
});
