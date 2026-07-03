/**
 * `/siltpoke-explain` CLI tests.
 */
import { test, expect, describe } from "bun:test";
import {
  EXIT_CODE,
  formatHuman,
  formatJson,
  parseArgs,
} from "../../src/cli/explain";
import type { ExplainResult } from "../../src/explain/types";

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

describe("parseArgs", () => {
  test("positional target captured", () => {
    const opts = parseArgs(["runDoctor"]);
    expect(opts.target).toBe("runDoctor");
    expect(opts.depth).toBe(1);
    expect(opts.force).toBe(false);
    expect(opts.json).toBe(false);
  });

  test("--depth 2 parsed", () => {
    expect(parseArgs(["runDoctor", "--depth", "2"]).depth).toBe(2);
  });

  test("--depth value validates to 1 or 2; invalid clamps to 1", () => {
    expect(parseArgs(["x", "--depth", "9"]).depth).toBe(1);
  });

  test("--force flag", () => {
    expect(parseArgs(["x", "--force"]).force).toBe(true);
  });

  test("--json flag", () => {
    expect(parseArgs(["x", "--json"]).json).toBe(true);
  });

  test("target qualified `path:symbol` preserved", () => {
    expect(parseArgs(["src/a.ts:foo"]).target).toBe("src/a.ts:foo");
  });

  test("no target → undefined; CLI handles as usage error", () => {
    expect(parseArgs([]).target).toBeUndefined();
  });
});

describe("formatHuman", () => {
  test("explained result includes H1 + cost line + cache path", () => {
    const out = formatHuman({
      kind: "explained",
      result: makeResult(),
      lowConfidence: false,
      truncated: false,
      usage: makeResult().meta.brain_usage,
      softCapExceeded: false,
      softCapUsd: 0.05,
    });
    expect(out).toContain("runDoctor");
    expect(out).toContain("[src/cli/doctor.ts:42-87]");
    expect(out).toContain("$0.003");
    expect(out).toContain(".meta.json");
  });

  test("low confidence emits warning banner", () => {
    const r = makeResult({ low_confidence: true, evidence_score: 0.5 });
    const out = formatHuman({
      kind: "explained",
      result: r,
      lowConfidence: true,
      truncated: false,
      usage: r.meta.brain_usage,
      softCapExceeded: false,
      softCapUsd: 0.05,
    });
    expect(out.toLowerCase()).toMatch(/low.confidence|⚠/);
  });

  test("ambiguous prints ranked menu", () => {
    const out = formatHuman({
      kind: "ambiguous",
      candidates: [
        {
          nodeId: "function:src/a.ts:parse",
          type: "function",
          name: "parse",
          path: "src/a.ts",
          lineRange: [10, 20],
        },
        {
          nodeId: "function:src/b.ts:parse",
          type: "function",
          name: "parse",
          path: "src/b.ts",
          lineRange: [5, 8],
        },
      ],
    });
    expect(out).toContain("matches");
    expect(out).toContain("src/a.ts:10");
    expect(out).toContain("src/b.ts:5");
  });

  test("not_found prints suggestions", () => {
    const out = formatHuman({
      kind: "not_found",
      target: "runDoctr",
      suggestions: ["runDoctor", "helper"],
    });
    expect(out).toContain("not found");
    expect(out).toContain("runDoctor");
  });

  test("pre_check_failed message surfaces unchanged", () => {
    const out = formatHuman({
      kind: "pre_check_failed",
      message: "Run /siltpoke-index first",
    });
    expect(out).toContain("Run /siltpoke-index first");
  });

  test("cost_cap_exceeded shows the offending cost", () => {
    const out = formatHuman({
      kind: "cost_cap_exceeded",
      usage: makeResult().meta.brain_usage,
      costUsd: 0.025,
    });
    expect(out).toContain("0.025");
    expect(out.toLowerCase()).toContain("cost");
  });
});

describe("formatJson", () => {
  test("explained envelope shape", () => {
    const out = JSON.parse(
      formatJson({
        kind: "explained",
        result: makeResult(),
        lowConfidence: false,
        truncated: false,
        usage: makeResult().meta.brain_usage,
      softCapExceeded: false,
      softCapUsd: 0.05,
      }),
    );
    expect(out.success).toBe(true);
    expect(out.data.kind).toBe("explained");
    expect(out.data.mdPath).toBeDefined();
    expect(out.data.evidence_score).toBe(1);
    expect(out.error).toBeNull();
  });

  test("not_found envelope marks success false + carries suggestions", () => {
    const out = JSON.parse(
      formatJson({
        kind: "not_found",
        target: "runDoctr",
        suggestions: ["runDoctor"],
      }),
    );
    expect(out.success).toBe(false);
    expect(out.data.suggestions).toEqual(["runDoctor"]);
    expect(out.error).toBeTruthy();
  });

  test("ambiguous envelope carries candidates", () => {
    const out = JSON.parse(
      formatJson({
        kind: "ambiguous",
        candidates: [
          {
            nodeId: "function:src/a.ts:parse",
            type: "function",
            name: "parse",
            path: "src/a.ts",
            lineRange: [10, 20],
          },
        ],
      }),
    );
    expect(out.success).toBe(false);
    expect(out.data.candidates).toHaveLength(1);
  });
});

describe("EXIT_CODE", () => {
  test("each outcome kind maps to expected exit code", () => {
    expect(EXIT_CODE.explained).toBe(0);
    expect(EXIT_CODE.pre_check_failed).toBe(1);
    expect(EXIT_CODE.ambiguous).toBe(1);
    expect(EXIT_CODE.not_found).toBe(2);
    expect(EXIT_CODE.cost_cap_exceeded).toBe(3);
  });
});
