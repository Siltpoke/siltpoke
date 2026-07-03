/**
 * cache.ts tests (graph_indexed_ts invalidation).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCachedExplanation } from "../../src/explain/cache";
import { cacheKey, writeExplanation } from "../../src/explain/store";
import {
  EXPLANATION_SCHEMA_VERSION,
  type ExplanationMeta,
} from "../../src/explain/types";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-explain-cache-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeMeta(ts = "2026-05-27T10:00:00.000Z"): ExplanationMeta {
  const targetNodeId = "function:src/cli/doctor.ts:runDoctor";
  return {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: "runDoctor",
    target_node_id: targetNodeId,
    target_key_sha256: cacheKey(targetNodeId),
    graph_indexed_ts: ts,
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.001,
    },
    evidence_score: 1.0,
    low_confidence: false,
    depth: 1,
    created_ts: ts,
  };
}

describe("readCachedExplanation", () => {
  test("returns null when no cached file exists", async () => {
    const out = await readCachedExplanation(cwd, "missing", "2026-01-01T00:00:00.000Z");
    expect(out).toBeNull();
  });

  test("hit when graph_indexed_ts matches", async () => {
    const meta = makeMeta();
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(cwd, meta.target_key_sha256, meta.graph_indexed_ts);
    expect(out).not.toBeNull();
    expect(out?.markdown).toBe("# x\n");
    expect(out?.fromCache).toBe(true);
  });

  test("miss when graph_indexed_ts mismatches (graph re-indexed)", async () => {
    const meta = makeMeta("2026-05-27T10:00:00.000Z");
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      "2026-05-28T10:00:00.000Z",
    );
    expect(out).toBeNull();
  });

  test("miss when cached meta has corrupt graph_indexed_ts shape", async () => {
    const meta = makeMeta();
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      "",
    );
    expect(out).toBeNull();
  });
});

describe("readCachedExplanation — source_fingerprint check", () => {
  const FP_A = "fingerprint-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const FP_B = "fingerprint-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  test("hit when graph_indexed_ts matches AND fingerprint matches", async () => {
    const meta = makeMeta();
    meta.source_fingerprint = FP_A;
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      meta.graph_indexed_ts,
      FP_A,
    );
    expect(out).not.toBeNull();
    expect(out?.fromCache).toBe(true);
  });

  test("miss when fingerprint mismatches (source file changed since cache)", async () => {
    const meta = makeMeta();
    meta.source_fingerprint = FP_A;
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      meta.graph_indexed_ts,
      FP_B,
    );
    expect(out).toBeNull();
  });

  test("miss when cached meta has no source_fingerprint (self-heal)", async () => {
    const meta = makeMeta();
    // source_fingerprint deliberately omitted on the cached entry.
    expect(meta.source_fingerprint).toBeUndefined();
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      meta.graph_indexed_ts,
      FP_A,
    );
    expect(out).toBeNull();
  });

  test("hit when caller passes no expected fingerprint (backward-compat: fingerprint check skipped)", async () => {
    const meta = makeMeta();
    // No source_fingerprint anywhere.
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      meta.graph_indexed_ts,
      // omitted fourth arg
    );
    expect(out).not.toBeNull();
  });

  test("miss when graph_indexed_ts mismatches even if fingerprint matches", async () => {
    const meta = makeMeta("2026-05-27T10:00:00.000Z");
    meta.source_fingerprint = FP_A;
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      "2026-05-28T10:00:00.000Z",
      FP_A,
    );
    expect(out).toBeNull();
  });

  test("miss when both graph_indexed_ts AND fingerprint mismatch", async () => {
    const meta = makeMeta("2026-05-27T10:00:00.000Z");
    meta.source_fingerprint = FP_A;
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      "2026-05-28T10:00:00.000Z",
      FP_B,
    );
    expect(out).toBeNull();
  });

  test("hit preserves cached meta fields including source_fingerprint", async () => {
    const meta = makeMeta();
    meta.source_fingerprint = FP_A;
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      meta.graph_indexed_ts,
      FP_A,
    );
    expect(out?.meta.source_fingerprint).toBe(FP_A);
    expect(out?.meta.graph_indexed_ts).toBe(meta.graph_indexed_ts);
  });

  test("expected fingerprint = empty string is treated as 'no expectation' (graph_indexed_ts only)", async () => {
    // Mirrors existing behavior where `expectedGraphIndexedTs === ""` short-circuits to null.
    // Here we test that empty expected fingerprint with valid graph_indexed_ts hits if cache has no fingerprint.
    // This codifies the "missing param OR empty string = skip fingerprint check" contract.
    const meta = makeMeta();
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readCachedExplanation(
      cwd,
      meta.target_key_sha256,
      meta.graph_indexed_ts,
      "",
    );
    expect(out).not.toBeNull();
  });
});
