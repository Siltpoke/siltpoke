/**
 * explain store round-trip tests.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheKey,
  explanationPaths,
  listExplanations,
  readExplanation,
  writeExplanation,
} from "../../src/explain/store";
import {
  EXPLANATION_SCHEMA_VERSION,
  type ExplanationMeta,
} from "../../src/explain/types";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-explain-store-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<ExplanationMeta> = {}): ExplanationMeta {
  return {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: "runDoctor",
    target_node_id: "function:src/cli/doctor.ts:runDoctor",
    target_key_sha256: cacheKey("function:src/cli/doctor.ts:runDoctor"),
    graph_indexed_ts: "2026-05-27T10:00:00.000Z",
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 1200,
      output_tokens: 400,
      total_cost_usd: 0.003,
    },
    evidence_score: 1.0,
    low_confidence: false,
    depth: 1,
    created_ts: "2026-05-27T10:05:00.000Z",
    ...overrides,
  };
}

describe("cacheKey", () => {
  test("stable hash for same node id", () => {
    expect(cacheKey("function:src/x.ts:foo")).toBe(
      cacheKey("function:src/x.ts:foo"),
    );
  });

  test("differs across node ids", () => {
    expect(cacheKey("function:src/x.ts:foo")).not.toBe(
      cacheKey("function:src/x.ts:bar"),
    );
  });

  test("12-char hex prefix of sha256", () => {
    const k = cacheKey("function:src/x.ts:foo");
    expect(k).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("explanationPaths", () => {
  test("returns md + meta paths under {cwd}/.siltpoke/explanations", () => {
    const paths = explanationPaths(cwd, "abc123def456");
    expect(paths.mdPath).toBe(
      join(cwd, ".siltpoke", "explanations", "abc123def456.md"),
    );
    expect(paths.metaPath).toBe(
      join(cwd, ".siltpoke", "explanations", "abc123def456.meta.json"),
    );
  });
});

describe("write + read round-trip", () => {
  test("writeExplanation creates both files atomically", async () => {
    const meta = makeMeta();
    const md = "# runDoctor\n\nA test explanation.\n";
    const result = await writeExplanation(cwd, meta.target_key_sha256, md, meta);
    expect(existsSync(result.mdPath)).toBe(true);
    expect(existsSync(result.metaPath)).toBe(true);
  });

  test("readExplanation returns null when both files missing", async () => {
    const result = await readExplanation(cwd, "nonexistent");
    expect(result).toBeNull();
  });

  test("readExplanation returns md + meta on hit", async () => {
    const meta = makeMeta();
    const md = "# runDoctor\n\nbody\n";
    await writeExplanation(cwd, meta.target_key_sha256, md, meta);
    const result = await readExplanation(cwd, meta.target_key_sha256);
    expect(result).not.toBeNull();
    expect(result?.markdown).toBe(md);
    expect(result?.meta.target).toBe("runDoctor");
    expect(result?.meta.graph_indexed_ts).toBe(meta.graph_indexed_ts);
  });

  test("readExplanation returns null when meta corrupt", async () => {
    const meta = makeMeta();
    const md = "# runDoctor\n";
    const result = await writeExplanation(cwd, meta.target_key_sha256, md, meta);
    // corrupt meta file
    await Bun.write(result.metaPath, "{ not json");
    const out = await readExplanation(cwd, meta.target_key_sha256);
    expect(out).toBeNull();
  });

  test("readExplanation returns null when md missing but meta present", async () => {
    const meta = makeMeta();
    const md = "# x\n";
    const result = await writeExplanation(cwd, meta.target_key_sha256, md, meta);
    rmSync(result.mdPath);
    const out = await readExplanation(cwd, meta.target_key_sha256);
    expect(out).toBeNull();
  });

  test("writeExplanation creates parent dir if missing", async () => {
    const meta = makeMeta();
    const result = await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    expect(existsSync(join(cwd, ".siltpoke", "explanations"))).toBe(true);
    expect(existsSync(result.mdPath)).toBe(true);
  });

  test("listExplanations returns empty array when dir missing", async () => {
    const out = await listExplanations(cwd);
    expect(out).toEqual([]);
  });

  test("listExplanations returns entries sorted by created_ts desc", async () => {
    const m1 = makeMeta();
    m1.target = "older";
    m1.created_ts = "2026-05-27T10:00:00.000Z";
    await writeExplanation(cwd, "older0001", "# older\n", m1);
    const m2 = makeMeta();
    m2.target = "newer";
    m2.created_ts = "2026-05-27T12:00:00.000Z";
    await writeExplanation(cwd, "newer0001", "# newer\n", m2);
    const entries = await listExplanations(cwd);
    expect(entries.map((e) => e.target)).toEqual(["newer", "older"]);
  });

  test("listExplanations skips corrupt meta", async () => {
    const meta = makeMeta();
    const result = await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    await Bun.write(result.metaPath, "{ not json");
    const out = await listExplanations(cwd);
    expect(out).toHaveLength(0);
  });

  test("overwriting an existing explanation works", async () => {
    const meta = makeMeta();
    await writeExplanation(cwd, meta.target_key_sha256, "# v1\n", meta);
    const newMeta = makeMeta({
      created_ts: "2026-05-27T11:00:00.000Z",
      evidence_score: 0.8,
      low_confidence: true,
    });
    await writeExplanation(cwd, meta.target_key_sha256, "# v2\n", newMeta);
    const out = await readExplanation(cwd, meta.target_key_sha256);
    expect(out?.markdown).toBe("# v2\n");
    expect(out?.meta.low_confidence).toBe(true);
  });
});

describe("source_fingerprint (schema extension)", () => {
  test("round-trip preserves source_fingerprint field", async () => {
    const meta = makeMeta({ source_fingerprint: "abc123def456789012345678901234567890abcdef" });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readExplanation(cwd, meta.target_key_sha256);
    expect(out?.meta.source_fingerprint).toBe(
      "abc123def456789012345678901234567890abcdef",
    );
  });

  test("round-trip omits source_fingerprint when undefined (backward-compat)", async () => {
    const meta = makeMeta();
    // makeMeta() defaults do NOT include source_fingerprint.
    expect(meta.source_fingerprint).toBeUndefined();
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const out = await readExplanation(cwd, meta.target_key_sha256);
    expect(out?.meta.source_fingerprint).toBeUndefined();
  });

  test("overwriting persists updated source_fingerprint", async () => {
    const m1 = makeMeta({ source_fingerprint: "first-sha-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    await writeExplanation(cwd, m1.target_key_sha256, "# v1\n", m1);
    const m2 = makeMeta({
      created_ts: "2026-05-27T11:00:00.000Z",
      source_fingerprint: "second-sha-value-bbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    await writeExplanation(cwd, m1.target_key_sha256, "# v2\n", m2);
    const out = await readExplanation(cwd, m1.target_key_sha256);
    expect(out?.meta.source_fingerprint).toBe(
      "second-sha-value-bbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  test("listExplanations summary does NOT surface source_fingerprint (intentional out-of-scope)", async () => {
    const meta = makeMeta({ source_fingerprint: "anything" });
    await writeExplanation(cwd, meta.target_key_sha256, "# x\n", meta);
    const entries = await listExplanations(cwd);
    expect(entries).toHaveLength(1);
    // ExplanationListEntry deliberately does not expose source_fingerprint
    // (list page only needs target + cache-state signals); cache-lifecycle
    // logic reads the full meta separately via readExplanation().
    expect((entries[0] as unknown as Record<string, unknown>).source_fingerprint).toBeUndefined();
  });
});
