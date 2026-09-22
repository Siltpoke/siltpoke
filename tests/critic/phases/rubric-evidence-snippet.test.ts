// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The rubric section used to render `message` only, so the one thing in it the
 * reviewer could legally cite — the offending source line, which the engine had
 * already collected as `RubricTrigger.snippet` — never reached the prompt. The
 * reviewer quoted the message instead, and the evidence check refused it: the
 * guard corpus is built from four tools the rubric is not one of.
 *
 * Two halves, and the second is the one that would otherwise go untested: the
 * function that renders the line, and the NORMAL phase that must put the same
 * line into the guard corpus. `runNormalPhase` is driven directly because that
 * is where the corpus is assembled and because `v2.rubricTriggers` is its own
 * argument — `runCritic` has no seam to inject a trigger through (the pre-Brain
 * pipeline scans real files on disk).
 *
 * The negative controls are the point: a citation of the rule MESSAGE must stay
 * refused, and with no triggers at all the same snippet citation must fail.
 * Without them a corpus that swallowed the whole section would pass every
 * positive assertion here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BrainCallResult, CallBrainOptions } from "../../../src/brain/brain";
import type { BrainProviderMeta } from "../../../src/brain/provider";
import type { BrainOutput } from "../../../src/brain/schema";
import { evidenceItemSchema } from "../../../src/brain/schema";
import {
  buildRubricEvidenceSection,
  citableRubricSnippet,
  rubricEvidenceCitationTokens,
} from "../../../src/critic/phases/archive";
import { runNormalPhase } from "../../../src/critic/phases/normal";
import {
  __setTestGapDeps,
  type TestGapDeps,
  testGapRule,
} from "../../../src/critic/rubric/tier1/test-gap";
import type { RubricTrigger } from "../../../src/critic/rubric/types";
import type { ToolName, ToolResult } from "../../../src/critic/tools/types";
import type { BrainContext, TimingTrace, V2ResultFields } from "../../../src/critic/types";

// The real trigger behind critique c-51c2 (2026-08-25), verbatim from the
// recorded trace — the case that started this: five citations, five dropped.
const REAL_TRIGGER: RubricTrigger = {
  rule_id: "god-function",
  tier: 2,
  severity: "high",
  file: "src/eval/refutation/run-input.ts",
  line: 176,
  end_line: 241,
  snippet_is_source: true,
  snippet:
    "function render(cells: Cell[], repeats: number, aborted: string | null, device: string[]): string {",
  message:
    "Function 'render' exceeds threshold: LOC=66 (threshold 50), cognitive complexity=16 (threshold 15). Consider splitting into smaller, single-purpose functions.",
};

const REAL_CODE = REAL_TRIGGER.snippet;

function trigger(overrides: Partial<RubricTrigger>): RubricTrigger {
  return { ...REAL_TRIGGER, ...overrides };
}

// ---------------------------------------------------------------------------
// Half 1 — the rendered section
// ---------------------------------------------------------------------------

describe("buildRubricEvidenceSection", () => {
  test("renders the source line the rule fired on, not only its message", () => {
    const section = buildRubricEvidenceSection([REAL_TRIGGER]);
    expect(section).toContain(REAL_TRIGGER.message);
    expect(section).toContain(`  code: ${REAL_CODE}`);
  });

  test("a snippet outside the evidence schema's band is shown without a code: line", () => {
    // Offering it would invite an item the schema rejects at parse, or one the
    // reviewer trims to fit — which then fails the verbatim check anyway.
    const tooShort = trigger({ snippet: "x = 1;" });
    const tooLong = trigger({ snippet: `const a = "${"y".repeat(300)}";` });

    for (const t of [tooShort, tooLong]) {
      const section = buildRubricEvidenceSection([t]);
      expect(section).toContain(t.message); // the finding still shows
      expect(section).not.toContain("  code: ");
      expect(rubricEvidenceCitationTokens([t])).toEqual([]);
    }
  });

  test("the band matches what the evidence schema actually accepts", () => {
    // Pins the two constants to their source of truth rather than to a number
    // typed twice: if `evidenceItemSchema.snippet` moves, this fails here
    // instead of silently offering uncitable lines in production.
    const item = (snippet: string) => ({
      tool: "tsc" as const,
      file: "a.ts",
      line: 1,
      snippet,
    });
    const shortest = citableRubricSnippet(trigger({ snippet: "a".repeat(10) }));
    const longest = citableRubricSnippet(trigger({ snippet: "b".repeat(240) }));
    if (shortest === null || longest === null) {
      throw new Error("the band's own endpoints must be citable");
    }
    expect(evidenceItemSchema.safeParse(item(shortest)).success).toBe(true);
    expect(evidenceItemSchema.safeParse(item(longest)).success).toBe(true);
    // One byte outside the band on each side is refused by BOTH.
    expect(citableRubricSnippet(trigger({ snippet: "a".repeat(9) }))).toBeNull();
    expect(citableRubricSnippet(trigger({ snippet: "b".repeat(241) }))).toBeNull();
    expect(evidenceItemSchema.safeParse(item("a".repeat(9))).success).toBe(false);
    expect(evidenceItemSchema.safeParse(item("b".repeat(241))).success).toBe(false);
  });

  test("section and citation tokens cap at the same place", () => {
    // A corpus longer than the section would certify a line the reviewer was
    // never shown. Each snippet is distinct so the 21st is identifiable.
    const many = Array.from({ length: 25 }, (_, i) =>
      trigger({ snippet: `const marker${String(i).padStart(3, "0")} = ${i};`, line: i + 1 }),
    );
    const section = buildRubricEvidenceSection(many);
    const tokens = rubricEvidenceCitationTokens(many);
    expect(tokens).toHaveLength(20);
    for (const t of tokens) expect(section).toContain(t);
    expect(section).not.toContain("marker020");
    expect(tokens.join("\n")).not.toContain("marker020");
  });

  test("a SYNTHESIZED snippet is never citable, however code-shaped it looks", () => {
    // `test-gap` emits `+45 lines added to src/foo.ts` as its snippet: siltpoke's
    // own accounting sentence, inside the length band, indistinguishable from a
    // source line to any length or shape check. Both reviewers of this change
    // found it independently. Absent `snippet_is_source` is the only thing that
    // tells them apart, so absence must refuse.
    const synthetic: RubricTrigger = {
      rule_id: "test-gap",
      tier: 1,
      severity: "med",
      file: "src/foo/bar.ts",
      line: 1,
      snippet: "+45 lines added to src/foo/bar.ts",
      message: "+45 lines added to `src/foo/bar.ts`; its disk test wasn't touched this diff.",
    };
    expect(citableRubricSnippet(synthetic)).toBeNull();
    expect(rubricEvidenceCitationTokens([synthetic])).toEqual([]);
    const section = buildRubricEvidenceSection([synthetic]);
    expect(section).toContain("test-gap"); // the finding still shows
    expect(section).not.toContain("  code: ");
  });

  test("the REAL test-gap rule emits a trigger that is uncitable", async () => {
    // Drives the actual rule rather than a hand-written fixture, so marking its
    // synthetic string as source anywhere in that file fails here. Deps are
    // injected to keep it off disk and off git: a non-degraded lookup with no
    // importers plus a new file is the `fireMed` branch.
    // Fake shape copied from tests/critic/rubric/tier1/test-gap-disk.test.ts —
    // `importers` must return the Map synchronously; the rule calls `.get` on it.
    __setTestGapDeps({
      isNewFile: () => true,
      importers: (() =>
        new Map([
          ["src/foo/bar.ts", { importers: [], truncated: false, degraded: false }],
        ])) as unknown as TestGapDeps["importers"],
    });
    try {
      const result = await testGapRule.run({
        cwd: "/r",
        changedFiles: ["src/foo/bar.ts"],
        diffHunks: [
          { file: "src/foo/bar.ts", addedLines: Array.from({ length: 45 }, (_, i) => i + 1) },
        ],
      });
      expect(result.triggers).toHaveLength(1);
      const t = result.triggers[0];
      if (t === undefined) throw new Error("unreachable — length asserted above");
      // The snippet IS in the band and IS single-line — only provenance saves us.
      expect(t.snippet.length).toBeGreaterThanOrEqual(10);
      expect(t.snippet).not.toContain("\n");
      expect(citableRubricSnippet(t)).toBeNull();
      expect(rubricEvidenceCitationTokens(result.triggers)).toEqual([]);
    } finally {
      __setTestGapDeps({});
    }
  });

  test("a MULTI-LINE snippet is never citable", () => {
    // `god-file` cites `src.slice(0, 200)` — real bytes, but several lines and
    // usually cut mid-token. It would break the one-bullet-per-finding shape and
    // offers the reviewer an arbitrary fragment as evidence.
    const multi = trigger({
      snippet: '// SPDX-License-Identifier: X\nimport { foo } from "bar";\nconst b',
    });
    expect(citableRubricSnippet(multi)).toBeNull();
    expect(rubricEvidenceCitationTokens([multi])).toEqual([]);
    expect(buildRubricEvidenceSection([multi])).not.toContain("  code: ");
  });

  test("the section carries no instruction — it is fenced as untrusted data", () => {
    // CRITIC_UNTRUSTED_DATA_FRAMING tells the reviewer never to obey text inside
    // the TOOL_OUTPUT fence, and this section is assembled into it. An
    // instruction placed here is inert by contract and reads as an injection
    // attempt. The citation rule lives in the system prompt instead.
    const section = buildRubricEvidenceSection([REAL_TRIGGER]);
    expect(section).not.toContain("MUST be");
    expect(section).not.toContain("When you cite");
    const prompt = readFileSync("src/brain/system-prompt.md", "utf8");
    expect(prompt).toContain("copy only the text AFTER `code: `");
    expect(prompt).toContain("set `tool` to `rubric`");
    // And it must NOT spell the section's literal header: that string is a
    // marker an arm-composition detector greps for (RUBRIC_HEADER,
    // src/eval/refutation/run-input.ts), so writing it here made every arm read
    // as carrying the rubric block. Caught by the full suite, not by review.
    expect(prompt).not.toContain("## Rubric evidence");
  });

  test("citation tokens carry the code and never the rule message", () => {
    const tokens = rubricEvidenceCitationTokens([REAL_TRIGGER]);
    expect(tokens).toEqual([REAL_CODE]);
    expect(tokens.join("\n")).not.toContain("exceeds threshold");
  });
});

// ---------------------------------------------------------------------------
// Half 2 — the wiring: does the line reach the guard corpus?
// ---------------------------------------------------------------------------

function makeToolResults(): Awaited<
  ReturnType<typeof import("../../../src/critic/tools/run-tools").runTools>
> {
  const results: Record<ToolName, ToolResult> = {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        {
          file: "src/eval/refutation/run-input.ts",
          line: 10,
          col: 5,
          severity: "error",
          code: "TS2322",
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ],
      raw: "src/eval/refutation/run-input.ts(10,5): error TS2322: Type 'number' is not assignable.",
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
  };
  return {
    ...results,
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  } as unknown as Awaited<
    ReturnType<typeof import("../../../src/critic/tools/run-tools").runTools>
  >;
}

function makeBrainContext(): BrainContext {
  return {
    personalitySystemPrompt: "You are Siltpoke.",
    memory: null,
    recent: [],
    sessionId: "sess-rubric",
    cwd: "/r",
    stateBase: "/r/.siltpoke",
  } as BrainContext;
}

function makeOutput(snippet: string): BrainOutput {
  return {
    mood: "concerned",
    pose: "arms_crossed",
    bubble_short: "render is too long",
    bubble_long: "render exceeds the size threshold.",
    critique_for_claude: "src/eval/refutation/run-input.ts:176 — render is 66 LOC.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    findings: [],
    evidence: [
      { tool: "tsc", file: "src/eval/refutation/run-input.ts", line: 176, snippet },
    ],
  };
}

const PROVIDER_META: BrainProviderMeta = {
  name: "claude",
  billing: "quota",
  genAiSystem: "anthropic",
} as BrainProviderMeta;

/** Drive the real NORMAL phase; return its label plus the prompt it assembled. */
async function runWith(
  triggers: RubricTrigger[],
  citedSnippet: string,
): Promise<{ label: string; unverified: number; prompt: string }> {
  let prompt = "";
  const timing: TimingTrace = { summary_ms: 0, critic_ms: 0, wall_ms: 0 };
  const v2: V2ResultFields = { pipelineRan: true, rubricTriggers: triggers };

  const result = await runNormalPhase({
    toolResults: makeToolResults(),
    brainContext: makeBrainContext(),
    source: "stop-hook",
    changedFiles: ["src/eval/refutation/run-input.ts"],
    homeBase: undefined,
    brainTimeoutMs: undefined,
    v2,
    diffSummaryPromise: Promise.resolve(undefined),
    diffBody: "",
    callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
      prompt = opts.systemPrompt;
      return {
        output: makeOutput(citedSnippet),
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 100,
          output_tokens: 50,
          total_cost_usd: 0,
        },
      };
    },
    writeCritiqueFn: async () => ({ id: "c-rubric-test", path: "/r" }),
    tracing: false,
    tracer: null,
    rootSpan: null,
    writeSpan: async () => {},
    redactCwdPaths: <T>(v: T) => v,
    timing,
    providerMeta: PROVIDER_META,
  });

  if (result.outcome.kind !== "ok") {
    throw new Error(`expected ok outcome, got ${result.outcome.kind}`);
  }
  return {
    label: result.outcome.evidenceLabel,
    unverified: result.outcome.unverifiedCount,
    prompt,
  };
}

describe("runNormalPhase — rubric source lines reach the guard corpus", () => {
  test("the code line reaches the prompt AND a verbatim citation of it verifies", async () => {
    const { label, unverified, prompt } = await runWith([REAL_TRIGGER], REAL_CODE);
    expect(prompt).toContain(REAL_CODE);
    expect(label).toBe("verified");
    expect(unverified).toBe(0);
  });

  test("NEGATIVE CONTROL: citing the rule MESSAGE is still refused", async () => {
    // siltpoke's own prose must not pass a check that asks whether a tool said
    // this — the same reason the Haiku diff summary is kept out of the corpus.
    // The message IS in the prompt, so this fails only because the corpus
    // deliberately excludes it.
    const cited = REAL_TRIGGER.message.slice(0, 120);
    const { label, unverified, prompt } = await runWith([REAL_TRIGGER], cited);
    expect(prompt).toContain(cited);
    expect(label).toBe("none_verified");
    expect(unverified).toBe(1);
  });

  test("NEGATIVE CONTROL: no triggers → the same citation is refused", async () => {
    // Proves the corpus extension is causally necessary rather than something
    // else in the prompt happening to contain this line.
    const { label, unverified, prompt } = await runWith([], REAL_CODE);
    expect(prompt).not.toContain(REAL_CODE);
    expect(label).toBe("none_verified");
    expect(unverified).toBe(1);
  });

  test("a citation declaring tool=rubric survives schema parse", async () => {
    // Before this, the enum held four tools and the rubric was not one of them,
    // so a reviewer that honestly named its source had the item dropped at parse
    // and the review labelled `no_evidence`. Found by the cross-family reviewer.
    expect(
      evidenceItemSchema.safeParse({
        tool: "rubric",
        file: "src/eval/refutation/run-input.ts",
        line: 176,
        snippet: REAL_CODE,
      }).success,
    ).toBe(true);
  });

  test("NEGATIVE CONTROL: an uncitable snippet gets no corpus entry", async () => {
    // The trigger fires and is shown, but its line is outside the schema band,
    // so nothing about it is citable — including the code itself.
    // Asserted on the PROMPT, not on the label: production coerces an over-long
    // snippet before the guard sees it, so a label assertion here would be about
    // a state the real path cannot reach (cross-family reviewer's catch).
    const tooLong = `const a = "${"y".repeat(300)}";`;
    const t = trigger({ snippet: tooLong });
    const { prompt } = await runWith([t], REAL_CODE);
    expect(prompt).toContain("god-function"); // the finding is still shown
    expect(prompt).not.toContain("  code: ");
    expect(rubricEvidenceCitationTokens([t])).toEqual([]);
  });
});
