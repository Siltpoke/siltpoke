/**
 * Defect [38] for the `/siltpoke-explain` CLI: an over-cap explanation is
 * shown AND the overspend is named. (Split out of explain.test.ts.)
 */
import { test, expect, describe } from "bun:test";
import { formatHuman } from "../../src/cli/explain";
import type { ExplainResult } from "../../src/explain/types";
import type { StalenessVerdict } from "../../src/repo-graph/staleness-verdict";

const FRESH_STALENESS: StalenessVerdict = {
  level: "fresh",
  headline: "index is current",
  counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, indexed: 3, wrong_ratio: 0 },
  caveat: null,
};

function makeResult(overrides: Partial<ExplainResult["meta"]> = {}): ExplainResult {
  const meta: ExplainResult["meta"] = {
    schemaVersion: 1,
    target: "runDoctor",
    target_node_id: "function:src/cli/doctor.ts:runDoctor",
    target_key_sha256: "abc123def456",
    graph_indexed_ts: "2026-05-27T10:00:00.000Z",
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 1200,
      output_tokens: 400,
      total_cost_usd: 0.0031,
    },
    evidence_score: 1.0,
    low_confidence: false,
    depth: 1,
    created_ts: "2026-05-27T10:05:00.000Z",
    ...overrides,
  };
  return {
    mdPath: "/tmp/x.md",
    metaPath: "/tmp/x.meta.json",
    markdown:
      "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n\n💡 Try `--depth 2` for transitive callers.\n",
    meta,
    fromCache: false,
  };
}

describe("formatHuman", () => {
  test("over the hard cap: the explanation is shown AND the overspend is named (defect [38])", () => {
    const base = makeResult().meta.brain_usage;
    const r = makeResult({ brain_usage: { ...base, total_cost_usd: 0.15 } });
    const out = formatHuman({
      kind: "explained",
      result: r,
      lowConfidence: false,
      truncated: false,
      usage: r.meta.brain_usage,
      softCapExceeded: true,
      softCapUsd: 0.05,
      hardCapExceeded: true,
      hardCapUsd: 0.1,
      staleness: FRESH_STALENESS,
    });
    expect(out).toContain("0.1500");
    expect(out).toContain("hard cap");
    expect(out).toContain("kept");
    expect(out).toContain("runDoctor");
    expect(out).not.toContain("soft cost cap");
  });

  test("under the hard cap: no hard-cap line", () => {
    const r = makeResult();
    const out = formatHuman({
      kind: "explained",
      result: r,
      lowConfidence: false,
      truncated: false,
      usage: r.meta.brain_usage,
      softCapExceeded: false,
      softCapUsd: 0.05,
      hardCapExceeded: false,
      hardCapUsd: 0.1,
      staleness: FRESH_STALENESS,
    });
    expect(out).not.toContain("hard cap");
  });
});
