import { describe, expect, test } from "bun:test";
import type { BrainCallResult, CallBrainOptions } from "../../../src/brain/brain";
import type { BrainOutput } from "../../../src/brain/schema";
import type {
  CallerResolver,
  CallerSet,
  ResolveOpts,
} from "../../../src/critic/caller-impact/caller-resolver";
import { findingsFromOutput, makeRealRunArm, type RealArmDeps } from "../../../src/eval/caller-impact/real-arm";
import type { EvalExample } from "../../../src/eval/caller-impact/manifest";
import { deterministicCatch } from "../../../src/eval/caller-impact/oracle";

// --- fakes -----------------------------------------------------------------

/** A resolver that knows a fixed caller for each named function; else unavailable. */
function fakeResolver(table: Record<string, CallerSet>): CallerResolver {
  return {
    async resolveCallers(name: string, _opts: ResolveOpts): Promise<CallerSet> {
      return (
        table[name] ?? {
          callers: [],
          defs: 0,
          ambiguous: false,
          callsiteCount: 0,
          unavailable: true,
        }
      );
    },
  };
}

function callerSet(file: string, line: number): CallerSet {
  return {
    callers: [{ file, line }],
    defs: 1,
    ambiguous: false,
    callsiteCount: 1,
    unavailable: false,
  };
}

function makeOutput(evidence: BrainOutput["evidence"]): BrainOutput {
  return {
    mood: evidence.length > 0 ? "concerned" : "happy",
    pose: "base",
    bubble_short: "x",
    bubble_long: "",
    critique_for_claude: evidence.length > 0 ? "caller may break" : "",
    severity: evidence.length > 0 ? "medium" : "info",
    confidence: "high",
    xp_earned_events: [],
    evidence,
  };
}

/**
 * Fake Brain that simulates a critic which USES the caller block: it scans the
 * system prompt for `caller: <file>:<line>` tokens and cites each as evidence.
 * No block ⇒ no caller tokens ⇒ no finding.
 */
function citingBrainFn(): RealArmDeps["callBrainFn"] {
  return async (opts: CallBrainOptions): Promise<BrainCallResult> => {
    const evidence: BrainOutput["evidence"] = [];
    for (const m of opts.systemPrompt.matchAll(/caller: ([\w./-]+):(\d+)/g)) {
      evidence.push({ tool: "ripgrep", file: m[1]!, line: Number(m[2]), snippet: `caller: ${m[1]}:${m[2]}` });
    }
    return {
      output: makeOutput(evidence),
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
    };
  };
}

const EXAMPLE: EvalExample = {
  id: "ex1",
  repo: "/tmp/fake-repo",
  diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-export function foo(x) {\n+export function foo(x, y) {\n",
  plantedBug: { file: "src/b.ts", function: "callerFn", line: 42 },
  isControl: false,
  changedFunction: "foo",
  wrongTarget: "bar",
};

function deps(): RealArmDeps {
  return {
    grep: fakeResolver({ foo: callerSet("src/b.ts", 42), bar: callerSet("src/c.ts", 99) }),
    graph: fakeResolver({ foo: callerSet("src/b.ts", 42) }),
    callBrainFn: citingBrainFn(),
    systemPromptBase: "You are Siltpoke.",
  };
}

// --- tests -----------------------------------------------------------------

describe("makeRealRunArm — the caller block changes what the critic catches", () => {
  test("baseline (no block) → planted cross-file caller NOT caught", async () => {
    const findings = await makeRealRunArm(deps())(EXAMPLE, "baseline");
    expect(deterministicCatch(EXAMPLE.plantedBug!, findings)).toBe(false);
  });

  test("grep-sigdelta → block surfaces the planted caller → CAUGHT", async () => {
    const findings = await makeRealRunArm(deps())(EXAMPLE, "grep-sigdelta");
    expect(findings).toContainEqual({ file: "src/b.ts", line: 42 });
    expect(deterministicCatch(EXAMPLE.plantedBug!, findings)).toBe(true);
  });

  test("graph-sigdelta → block surfaces the planted caller → CAUGHT", async () => {
    const findings = await makeRealRunArm(deps())(EXAMPLE, "graph-sigdelta");
    expect(deterministicCatch(EXAMPLE.plantedBug!, findings)).toBe(true);
  });

  test("coherent-irrelevant (wrong target) → real block but NOT about the planted bug → NOT caught", async () => {
    const findings = await makeRealRunArm(deps())(EXAMPLE, "coherent-irrelevant");
    // It DID surface a caller (coherent) — just for the wrong file.
    expect(findings).toContainEqual({ file: "src/c.ts", line: 99 });
    expect(deterministicCatch(EXAMPLE.plantedBug!, findings)).toBe(false);
  });
});

describe("resilience — a transient Brain failure scores the cell as no-findings, never aborts", () => {
  test("callBrainFn throws → empty findings + failure counted", async () => {
    const { armBrainFailures } = await import("../../../src/eval/caller-impact/real-arm");
    const before = armBrainFailures["grep-sigdelta"] ?? 0;
    const d = deps();
    d.callBrainFn = async () => {
      throw new Error("claude -p exited with code 143");
    };
    const findings = await makeRealRunArm(d)(EXAMPLE, "grep-sigdelta");
    expect(findings).toEqual([]);
    expect(armBrainFailures["grep-sigdelta"]).toBe(before + 1);
  });

  test("a RESOLVER crash (not just the Brain) scores the cell as no-findings, not abort", async () => {
    const d = deps();
    // graph resolver throws — must not propagate out and kill the whole run.
    d.graph = {
      async resolveCallers() {
        throw new Error("graph index corrupt");
      },
    };
    const findings = await makeRealRunArm(d)(EXAMPLE, "graph-sigdelta");
    expect(findings).toEqual([]);
  });
});

describe("findingsFromOutput", () => {
  test("maps evidence array + parses critique_for_claude prose citations", () => {
    const out = makeOutput([{ tool: "tsc", file: "src/x.ts", line: 5, snippet: "x".repeat(12) }]);
    out.critique_for_claude = "see src/y.ts:88 for the broken caller";
    const findings = findingsFromOutput(out);
    expect(findings).toContainEqual({ file: "src/x.ts", line: 5 });
    expect(findings).toContainEqual({ file: "src/y.ts", line: 88 });
  });

  test("dedupes a site cited in BOTH evidence and prose (no redundant grader calls)", () => {
    const out = makeOutput([{ tool: "tsc", file: "src/x.ts", line: 5, snippet: "x".repeat(12) }]);
    out.critique_for_claude = "the break is at src/x.ts:5 exactly";
    const findings = findingsFromOutput(out);
    expect(findings.filter((f) => f.file === "src/x.ts" && f.line === 5)).toHaveLength(1);
  });
});
