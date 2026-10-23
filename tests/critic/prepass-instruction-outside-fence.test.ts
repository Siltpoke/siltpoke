// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke's own pre-pass instruction must sit OUTSIDE every untrusted fence.
 *
 * Smoke 2026-10-20 (R19): codex listed "If any risk is concrete and actionable,
 * mention it in `critique_for_claude` and elevate `severity`…" in
 * `injection_suspected` on 3 of 8 runs, clean control included. The framing
 * tells the reviewer that instruction-shaped text inside a `<<<TAG:nonce` fence
 * is an injection — and the sentence was inside the TOOL_OUTPUT fence, because
 * the diff-summary block carrying it was joined into the tool output.
 *
 * Driven through `runCritic`'s NORMAL path, so it reads the prompt production
 * actually assembles rather than a re-implementation of the join.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainOutput } from "../../src/brain/schema";
import { type RunCriticDeps, type RunCriticOpts, runCritic } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

const INSTRUCTION =
  "If any risk is concrete and actionable, mention it in `critique_for_claude` and elevate `severity` from `info` to at least `low`. Do NOT silently emit info-only when risks exist.";
const ADDRESS_EACH = "address each";
const RISK = "drops the tenant check on the admin route";

const DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 111..222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,3 @@",
  "-export function foo(a) {",
  "+export function foo(a, b) {",
  "   return a;",
  " }",
].join("\n");

let home = "";
let prevHome: string | undefined;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "prepass-fence-"));
  prevHome = process.env.SILTPOKE_HOME;
  process.env.SILTPOKE_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function opts(changedFiles: string[] = ["src/foo.ts"]): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: home,
    changedFiles,
    caps: {
      cwd: home, hasGit: true, hasTsc: false, hasEslint: false, hasRipgrep: false,
      tsconfigPaths: [], eslintConfigPaths: [], detectedAt: Date.now(), configMtimes: {},
    },
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-fence",
      cwd: home,
      stateBase: join(home, ".siltpoke"),
    },
  };
}

/** A tsc error forces the NORMAL path; the diff makes the pre-pass run. */
function tools(): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
  return {
    tsc: {
      tool: "tsc", status: "ok",
      parsed: [{ file: "src/foo.ts", line: 1, col: 1, severity: "error", code: "TS2322", message: "Type 'number' is not assignable to type 'string'." }],
      raw: "src/foo.ts(1,1): error TS2322: Type 'number' is not assignable.",
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: DIFF },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

function brain(): BrainOutput {
  return {
    mood: "annoyed", pose: "arms_crossed", bubble_short: "x", bubble_long: "x",
    critique_for_claude: "x", severity: "low", confidence: "high",
    xp_earned_events: [], findings: [], evidence: [],
  };
}

const ZERO = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0 };

async function promptFor(risks: string[], changedFiles?: string[]): Promise<string> {
  let captured = "";
  const deps: RunCriticDeps = {
    runToolsFn: async () => tools() as never,
    callBrainFn: async (o) => {
      captured = o.systemPrompt;
      return { output: brain(), usage: ZERO };
    },
    runDiffSummaryFn: async () => ({
      summary: { intent: "widen foo", key_changes: ["foo takes b"], risks, file_count: 1, files_with_purpose: [], source: "haiku" as const },
      usage: ZERO,
    }),
    writeCritiqueFn: async () => ({ id: "c-fence", path: join(home, "c") }),
  };
  const result = await runCritic(opts(changedFiles), deps);
  expect(result.decision).toBe("NORMAL");
  return captured;
}

/** Every `<<<TAG:nonce … TAG:nonce>>>` region, and the prompt with them cut out. */
function splitFences(prompt: string): { inside: string[]; outside: string } {
  const re = /<<<([A-Z_]+):([0-9a-f-]+)\n([\s\S]*?)\n\1:\2>>>/g;
  const inside = [...prompt.matchAll(re)].map((m) => m[3]!);
  return { inside, outside: prompt.replace(re, "") };
}

describe("pre-pass instruction vs the untrusted fences", () => {
  test("the instruction is siltpoke's text: outside every fence, and said once", async () => {
    const prompt = await promptFor([RISK]);
    const { inside, outside } = splitFences(prompt);
    expect(inside.length).toBeGreaterThan(0); // the fences were really found
    for (const body of inside) {
      expect(body).not.toContain(INSTRUCTION);
      expect(body.toLowerCase()).not.toContain(ADDRESS_EACH);
    }
    expect(outside).toContain(INSTRUCTION);
    expect(prompt.split(INSTRUCTION).length - 1).toBe(1);
  });

  test("the pre-pass DATA stays inside the TOOL_OUTPUT fence", async () => {
    const prompt = await promptFor([RISK]);
    const { inside, outside } = splitFences(prompt);
    expect(inside.some((b) => b.includes(RISK) && b.includes("## Diff summary (Haiku pre-pass)"))).toBe(true);
    expect(outside).not.toContain(RISK);
  });

  test("POSITIVE CONTROL — no risks, no instruction anywhere", async () => {
    const prompt = await promptFor([]);
    expect(prompt).not.toContain("elevate `severity`");
    expect(prompt).not.toContain(RUBRIC_INSTRUCTION); // no god file here, so no rubric triggers
  });
});

// R20: the rubric block had the same shape — siltpoke's closing instruction was
// the last line inside the TOOL_OUTPUT fence.
const RUBRIC_INSTRUCTION =
  "Incorporate these observations into your critique where relevant. Do NOT hallucinate additional findings.";

describe("rubric instruction vs the untrusted fences", () => {
  test("a real rubric trigger: its list is fenced data, siltpoke's instruction is outside", async () => {
    // A >500-line source file fires the tier-1 god-file rule through the real pipeline.
    const god = join(home, "src", "god.ts");
    mkdirSync(join(home, "src"), { recursive: true });
    writeFileSync(god, Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
    const prompt = await promptFor([RISK], [god]);
    const { inside, outside } = splitFences(prompt);
    expect(inside.some((b) => b.includes("## Rubric evidence") && b.includes("god-file"))).toBe(true);
    for (const body of inside) expect(body).not.toContain(RUBRIC_INSTRUCTION);
    expect(outside).toContain(RUBRIC_INSTRUCTION);
    expect(prompt.split(RUBRIC_INSTRUCTION).length - 1).toBe(1);
    // Both of siltpoke's lines, rubric first, as normal.ts joins them.
    expect(outside.indexOf(RUBRIC_INSTRUCTION)).toBeLessThan(outside.indexOf(INSTRUCTION));
  });

  test("rubric triggers but zero pre-pass risks: only the rubric instruction appears, outside every fence", async () => {
    const god = join(home, "src", "god2.ts");
    mkdirSync(join(home, "src"), { recursive: true });
    writeFileSync(god, Array.from({ length: 600 }, (_, i) => `export const w${i} = ${i};`).join("\n"));
    const prompt = await promptFor([], [god]);
    const { inside, outside } = splitFences(prompt);
    expect(inside.some((b) => b.includes("## Rubric evidence") && b.includes("god-file"))).toBe(true);
    for (const body of inside) expect(body).not.toContain(RUBRIC_INSTRUCTION);
    expect(outside).toContain(RUBRIC_INSTRUCTION);
    expect(prompt.split(RUBRIC_INSTRUCTION).length - 1).toBe(1);
    expect(prompt).not.toContain(INSTRUCTION);
  });
});
