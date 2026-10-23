import { describe, expect, test } from "bun:test";
import { buildToolOutputSection } from "../../src/brain/prompt-tools";
import type { BrainOutput, Finding } from "../../src/brain/schema";
import { guardCritique } from "../../src/critic/evidence-guard";
import type { ToolResult } from "../../src/critic/tools/types";

/**
 * Defect [52] (audit §57.4): the reviewer is shown a diagnostic as
 *
 *   - `src/hello.ts:52:3` — TS2322 error: Type 'string' is not assignable …
 *
 * and quotes it back without the backticks. The backticks are siltpoke's own
 * markup, not something tsc printed, and the raw tsc stdout has another shape
 * (`src/hello.ts(52,3): error TS2322: …`). So the quote matched neither, the
 * finding was refused as unverified, and nothing reached the learning queue.
 *
 * These tests run the REAL section builder into the REAL guard, the way
 * `src/critic/phases/normal.ts` wires them, so a fix in either half is seen.
 */

const TSC_MESSAGE = "Type 'string' is not assignable to type 'number'.";
const ESLINT_MESSAGE = "'unused' is defined but never used.";
const RG_TEXT = "export function loadConfig(path: string) {";

function results(): Record<"tsc" | "eslint" | "git-diff" | "ripgrep", ToolResult> {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [{ file: "src/hello.ts", line: 52, col: 3, severity: "error", code: "TS2322", message: TSC_MESSAGE }],
      raw: `src/hello.ts(52,3): error TS2322: ${TSC_MESSAGE}`,
    },
    eslint: {
      tool: "eslint",
      status: "ok",
      parsed: [{ file: "src/hello.ts", line: 7, col: 9, severity: "error", ruleId: "no-unused-vars", message: ESLINT_MESSAGE }],
      raw: "[]",
    },
    "git-diff": { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" },
    ripgrep: {
      tool: "ripgrep",
      status: "ok",
      parsed: [{ file: "src/config.ts", line: 14, text: RG_TEXT, pattern: "loadConfig" }],
      raw: "",
    },
  };
}

function corpus(): string {
  const { citationSection, evidenceCorpus } = buildToolOutputSection(results());
  return [citationSection, evidenceCorpus].join("\n");
}

const base: BrainOutput = {
  mood: "annoyed",
  pose: "arms_crossed",
  bubble_short: "type error",
  bubble_long: "",
  critique_for_claude: "fix the type",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
  findings: [],
  evidence: [],
};

const changed = new Set(["src/hello.ts"]);

function finding(quote: string, file = "src/hello.ts"): Finding {
  return { id: "f1", title: "type error", body: "the value is a string", severity: "medium", file, quote };
}

describe("[52] a quote that only drops siltpoke's backticks is verified", () => {
  test("precondition: the section really wraps the location in backticks", () => {
    expect(corpus()).toContain(`- \`src/hello.ts:52:3\` — TS2322 error: ${TSC_MESSAGE}`);
  });

  test("tsc: evidence item quoting the line without backticks", () => {
    const snippet = `src/hello.ts:52:3 — TS2322 error: ${TSC_MESSAGE}`;
    const out: BrainOutput = { ...base, evidence: [{ tool: "tsc", file: "src/hello.ts", snippet }] };
    const v = guardCritique(out, "NORMAL", corpus(), changed);
    expect(v.unverified).toEqual([]);
    expect(v.verified.map((e) => e.snippet)).toEqual([snippet]);
    expect(v.label).toBe("verified");
  });

  test("tsc: finding quoting the line without backticks", () => {
    const quote = `src/hello.ts:52:3 — TS2322 error: ${TSC_MESSAGE}`;
    const v = guardCritique({ ...base, findings: [finding(quote)] }, "NORMAL", corpus(), changed);
    expect(v.unverifiedFindings).toEqual([]);
    expect(v.verifiedFindings.map((f) => f.quote)).toEqual([quote]);
  });

  test("eslint: same shape, same answer", () => {
    const snippet = `src/hello.ts:7:9 — no-unused-vars error: ${ESLINT_MESSAGE}`;
    const out: BrainOutput = { ...base, evidence: [{ tool: "eslint", file: "src/hello.ts", snippet }] };
    const v = guardCritique(out, "NORMAL", corpus(), changed);
    expect(v.unverified).toEqual([]);
    expect(v.verified).toHaveLength(1);
  });

  test("ripgrep: same shape, same answer", () => {
    const snippet = `src/config.ts:14 — ${RG_TEXT}`;
    const out: BrainOutput = { ...base, evidence: [{ tool: "ripgrep", file: "src/config.ts", snippet }] };
    const v = guardCritique(out, "NORMAL", corpus(), changed);
    expect(v.unverified).toEqual([]);
    expect(v.verified).toHaveLength(1);
  });

  test("the quote WITH backticks still verifies (no regression)", () => {
    const snippet = `\`src/hello.ts:52:3\` — TS2322 error: ${TSC_MESSAGE}`;
    const out: BrainOutput = { ...base, evidence: [{ tool: "tsc", file: "src/hello.ts", snippet }] };
    expect(guardCritique(out, "NORMAL", corpus(), changed).unverified).toEqual([]);
  });
});

describe("[52] the guard is not loosened beyond the backticks", () => {
  test("a changed message is still refused", () => {
    const snippet = "src/hello.ts:52:3 — TS2322 error: Type 'number' is not assignable to type 'string'.";
    const out: BrainOutput = { ...base, evidence: [{ tool: "tsc", file: "src/hello.ts", snippet }] };
    const v = guardCritique(out, "NORMAL", corpus(), changed);
    expect(v.verified).toEqual([]);
    expect(v.unverified).toHaveLength(1);
    expect(v.unverified[0]!.reason).toContain("snippet not in evidence_corpus");
  });

  test("a wrong location is still refused", () => {
    const quote = `src/hello.ts:53:3 — TS2322 error: ${TSC_MESSAGE}`;
    const v = guardCritique({ ...base, findings: [finding(quote)] }, "NORMAL", corpus(), changed);
    expect(v.verifiedFindings).toEqual([]);
    expect(v.unverifiedFindings).toHaveLength(1);
  });

  test("a backtick-free quote of a line that was never a diagnostic is refused", () => {
    const snippet = "src/hello.ts:99:1 — TS9999 error: invented";
    const out: BrainOutput = { ...base, evidence: [{ tool: "tsc", file: "src/hello.ts", snippet }] };
    expect(guardCritique(out, "NORMAL", corpus(), changed).verified).toEqual([]);
  });
});

describe("[52] scope: only the list blocks, never the prompt, every line", () => {
  test("the prompt the reviewer sees is unchanged (no backtick-free copy)", () => {
    const { section } = buildToolOutputSection(results());
    expect(section).not.toContain(`- src/hello.ts:52:3 — TS2322 error: ${TSC_MESSAGE}`);
    expect(section).toContain(`- \`src/hello.ts:52:3\` — TS2322 error: ${TSC_MESSAGE}`);
  });

  test("the LAST of several diagnostics is unwrapped too", () => {
    const r = results();
    r.tsc = {
      tool: "tsc",
      status: "ok",
      parsed: [
        { file: "src/hello.ts", line: 10, col: 1, severity: "error", code: "TS2304", message: "Cannot find name 'a'." },
        { file: "src/hello.ts", line: 20, col: 1, severity: "error", code: "TS2304", message: "Cannot find name 'b'." },
        { file: "src/hello.ts", line: 30, col: 1, severity: "error", code: "TS2304", message: "Cannot find name 'c'." },
      ],
      raw: "",
    };
    const { citationSection, evidenceCorpus } = buildToolOutputSection(r);
    const snippet = "src/hello.ts:30:1 — TS2304 error: Cannot find name 'c'.";
    const out: BrainOutput = { ...base, evidence: [{ tool: "tsc", file: "src/hello.ts", snippet }] };
    expect(guardCritique(out, "NORMAL", `${citationSection}\n${evidenceCorpus}`, changed).verified).toHaveLength(1);
  });

  test("a ripgrep match carrying a CR is unwrapped", () => {
    const r = results();
    r.ripgrep = {
      tool: "ripgrep",
      status: "ok",
      parsed: [{ file: "src/crlf.ts", line: 3, text: "const a = 1;\r", pattern: "a" }],
      raw: "",
    };
    const { citationSection } = buildToolOutputSection(r);
    expect(citationSection).toContain("- src/crlf.ts:3 — const a = 1;\r");
  });

  test("a removed diff line shaped like a location line is NOT unwrapped", () => {
    const r = results();
    r["git-diff"] = {
      tool: "git-diff",
      status: "ok",
      parsed: [{ file: "src/doc.ts", header: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: "- `x` — y\n+z" }],
      raw: "",
    };
    const { citationSection } = buildToolOutputSection(r);
    expect(citationSection).toContain("- `x` — y");
    expect(citationSection).not.toContain("- x — y");
  });
});
