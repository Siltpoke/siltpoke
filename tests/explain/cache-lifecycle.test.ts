/**
 * explanation cache lifecycle state machine tests.
 * Derives NoCache / Cached / Stale per entry +
 * cascades invalidation file → symbols → subdir for the UI badge logic.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CacheState,
  cascadeStaleSubdir,
  deriveCacheState,
} from "../../src/explain/cache-lifecycle";
import { cacheKey, writeExplanation } from "../../src/explain/store";
import {
  EXPLANATION_SCHEMA_VERSION,
  type ExplanationMeta,
} from "../../src/explain/types";
import { emptyFingerprints, type Fingerprints } from "../../src/repo-graph/types";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-cache-lifecycle-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const FP_A = "fp-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FP_B = "fp-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeMeta(overrides: Partial<ExplanationMeta> = {}): ExplanationMeta {
  const nodeId = "function:src/cli/doctor.ts:runDoctor";
  return {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: "runDoctor",
    target_node_id: nodeId,
    target_key_sha256: cacheKey(nodeId),
    graph_indexed_ts: "2026-05-28T10:00:00.000Z",
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.003,
    },
    evidence_score: 1.0,
    low_confidence: false,
    depth: 1,
    created_ts: "2026-05-28T10:00:00.000Z",
    ...overrides,
  };
}

function fingerprintsFor(entries: Record<string, string>): Fingerprints {
  const fp = emptyFingerprints();
  for (const [path, sha] of Object.entries(entries)) {
    fp.files[path] = { content_sha256: sha, ast_sig: "noop" };
  }
  return fp;
}

describe("deriveCacheState — single target", () => {
  test("NoCache: no .meta.json file exists for the target", async () => {
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await deriveCacheState(
      "function:src/cli/doctor.ts:runDoctor",
      cwd,
      fp,
    );
    expect(result.state).toBe(CacheState.NoCache);
    expect(result.reason).toBeNull();
  });

  test("Cached: meta exists + source_fingerprint matches current", async () => {
    const meta = makeMeta({ source_fingerprint: FP_A });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await deriveCacheState(meta.target_node_id, cwd, fp);
    expect(result.state).toBe(CacheState.Cached);
    expect(result.reason).toBeNull();
  });

  test("Stale: source_fingerprint mismatches current", async () => {
    const meta = makeMeta({ source_fingerprint: FP_A });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_B });
    const result = await deriveCacheState(meta.target_node_id, cwd, fp);
    expect(result.state).toBe(CacheState.Stale);
    expect(result.reason).toContain("source file changed");
  });

  test("Stale (self-heal): cached entry missing source_fingerprint field", async () => {
    const meta = makeMeta();
    expect(meta.source_fingerprint).toBeUndefined();
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await deriveCacheState(meta.target_node_id, cwd, fp);
    expect(result.state).toBe(CacheState.Stale);
    expect(result.reason).toContain("predates fingerprint tracking");
  });

  test("Stale: fingerprints.json has no entry for the target's file", async () => {
    const meta = makeMeta({ source_fingerprint: FP_A });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ /* empty — file not tracked */ });
    const result = await deriveCacheState(meta.target_node_id, cwd, fp);
    expect(result.state).toBe(CacheState.Stale);
    expect(result.reason).toContain("not tracked");
  });

  test("idempotent: calling twice returns the same state", async () => {
    const meta = makeMeta({ source_fingerprint: FP_A });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const r1 = await deriveCacheState(meta.target_node_id, cwd, fp);
    const r2 = await deriveCacheState(meta.target_node_id, cwd, fp);
    expect(r1).toEqual(r2);
  });

  test("handles target_node_id with file: prefix (file-level target)", async () => {
    const nodeId = "file:src/cli/doctor.ts:";
    const meta = makeMeta({
      target_node_id: nodeId,
      target_key_sha256: cacheKey(nodeId),
      source_fingerprint: FP_A,
    });
    await writeExplanation(cwd, meta.target_key_sha256, "# file\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await deriveCacheState(nodeId, cwd, fp);
    expect(result.state).toBe(CacheState.Cached);
  });
});

describe("cascadeStaleSubdir", () => {
  test("returns empty lists when no cache entries exist under the subdir", async () => {
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual([]);
    expect(result.invalidatedSymbols).toEqual([]);
  });

  test("invalidates cache entry whose file's fingerprint mismatches", async () => {
    const meta = makeMeta({ source_fingerprint: FP_A });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_B }); // changed
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual(["src/cli/doctor.ts"]);
    expect(result.invalidatedSymbols).toContain("function:src/cli/doctor.ts:runDoctor");
  });

  test("does NOT invalidate a cache entry from a different subdir", async () => {
    const meta = makeMeta({
      target_node_id: "function:src/brain/brain.ts:callBrain",
      target_key_sha256: cacheKey("function:src/brain/brain.ts:callBrain"),
      source_fingerprint: FP_A,
    });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/brain/brain.ts": FP_B });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual([]);
    expect(result.invalidatedSymbols).toEqual([]);
  });

  test("groups multiple symbols in the same changed file under one file entry", async () => {
    const m1 = makeMeta({
      target: "runDoctor",
      target_node_id: "function:src/cli/doctor.ts:runDoctor",
      target_key_sha256: cacheKey("function:src/cli/doctor.ts:runDoctor"),
      source_fingerprint: FP_A,
    });
    const m2 = makeMeta({
      target: "checkSettingsJson",
      target_node_id: "function:src/cli/doctor.ts:checkSettingsJson",
      target_key_sha256: cacheKey("function:src/cli/doctor.ts:checkSettingsJson"),
      source_fingerprint: FP_A,
    });
    await writeExplanation(cwd, m1.target_key_sha256, "# 1\n", m1);
    await writeExplanation(cwd, m2.target_key_sha256, "# 2\n", m2);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_B });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual(["src/cli/doctor.ts"]);
    expect(result.invalidatedSymbols).toHaveLength(2);
  });

  test("subdir prefix match is exact, not substring (src/cli/ does NOT match src/clip/)", async () => {
    const meta = makeMeta({
      target_node_id: "function:src/clip/foo.ts:bar",
      target_key_sha256: cacheKey("function:src/clip/foo.ts:bar"),
      source_fingerprint: FP_A,
    });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/clip/foo.ts": FP_B });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual([]);
  });

  test("invalidates entries with missing source_fingerprint (self-heal)", async () => {
    const meta = makeMeta(); // no source_fingerprint
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual(["src/cli/doctor.ts"]);
  });

  test("does NOT invalidate when fingerprint matches (file unchanged)", async () => {
    const meta = makeMeta({ source_fingerprint: FP_A });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const fp = fingerprintsFor({ "src/cli/doctor.ts": FP_A });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles).toEqual([]);
    expect(result.invalidatedSymbols).toEqual([]);
  });

  test("aggregates across multiple changed files within the subdir", async () => {
    const m1 = makeMeta({
      target_node_id: "function:src/cli/doctor.ts:runDoctor",
      target_key_sha256: cacheKey("function:src/cli/doctor.ts:runDoctor"),
      source_fingerprint: FP_A,
    });
    const m2 = makeMeta({
      target_node_id: "function:src/cli/explain.ts:runExplainCli",
      target_key_sha256: cacheKey("function:src/cli/explain.ts:runExplainCli"),
      source_fingerprint: FP_A,
    });
    await writeExplanation(cwd, m1.target_key_sha256, "# 1\n", m1);
    await writeExplanation(cwd, m2.target_key_sha256, "# 2\n", m2);
    const fp = fingerprintsFor({
      "src/cli/doctor.ts": FP_B,
      "src/cli/explain.ts": FP_B,
    });
    const result = await cascadeStaleSubdir("src/cli/", cwd, fp);
    expect(result.invalidatedFiles.sort()).toEqual([
      "src/cli/doctor.ts",
      "src/cli/explain.ts",
    ]);
    expect(result.invalidatedSymbols).toHaveLength(2);
  });
});
