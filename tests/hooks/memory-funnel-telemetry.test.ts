// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Eval §3 step 1, T3 — the read-half memory funnel reaches the telemetry row
 * on the LIVE (m112 critic) path.
 *
 * This is the test that would have caught the bug that motivated the whole
 * track: `memory_rules_count` read 0 in 805/805 recent reviews, not because
 * memory was broken but because the field was only ever emitted on the legacy
 * Brain path, which no longer runs. A funnel that is computed correctly but
 * never lands on the row is indistinguishable from a funnel that measured
 * zero — so the assertion here is on the persisted JSONL, not on the
 * in-process return value.
 *
 * Spec: an internal design note §2.1
 */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStopHook } from "../../src/hooks/handle-stop";
import { writeMemory, emptyMemory, type LearnedRule } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";
import type { HookEvent } from "../../src/router/router";
import type { BrainOutput } from "../../src/brain/schema";
import { BrainError, type BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { makeGitRepo } from "../_shared/git-fixture";

const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

const REAL_SNIPPET = "const x: string = 42;";

function fakeBrainOutput(): BrainOutput {
  return {
    mood: "annoyed",
    pose: "base",
    bubble_short: "Type error found",
    bubble_long: "",
    critique_for_claude: "something actionable",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    // The evidence guard requires a verbatim substring of the tool corpus; an
    // unbacked critique is rejected before the NORMAL row is written.
    evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
    reasoning: "test fixture",
  };
}

/**
 * A tool result with a real finding. Deliberately NOT the all-clean fixture:
 * an all-clean run HARD_SUPPRESSes before prompt assembly, so it legitimately
 * has no funnel to report. This test is about the assembling path.
 */
function toolsWithFinding(): Record<ToolName, ToolResult> & {
  securityFindings: never[];
  owaspHints: never[];
  webSearchSources: never[];
} {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [{ file: "src/dummy.ts", line: 5, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." }],
      raw: `src/dummy.ts(5,1): error TS2322\n${REAL_SNIPPET}`,
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

function rule(id: string, fileTypes?: string[], effectiveness: "good" | "retired" = "good"): LearnedRule {
  return {
    id,
    rule: `rule body for ${id}`,
    category: "misc",
    created_at: "2026-05-14T00:00:00Z",
    applied_count: 0,
    effectiveness,
    ...(fileTypes ? { applies_to_file_types: fileTypes } : {}),
  } as LearnedRule;
}

/** Transcript whose only tool_use edits a .ts file, so detectFileTypes yields {ts}. */
function seedTranscript(dir: string): string {
  const edited = join(dir, "dummy.ts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(edited, "export const dummy = 1;\n");
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "touched dummy.ts" },
          { type: "tool_use", name: "Edit", input: { file_path: edited } },
        ],
      },
    })}\n`,
  );
  return transcriptPath;
}

function stopEvent(sessionId: string, transcriptPath: string, cwd: string): HookEvent {
  // The ⏱ review-unit gate asks git whether a unit of work closed, so a cwd
  // git knows nothing about is answered with `not_a_git_repo` before anything
  // else in this test can run. A real user's cwd is a repo; this makes the
  // fixture one too. See tests/_shared/git-fixture.ts.
  makeGitRepo(cwd);
  return { hook_event_name: "Stop", session_id: sessionId, transcript_path: transcriptPath, cwd };
}

async function runLiveStop(tmpHome: string, projectCwd: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const transcriptPath = seedTranscript(projectCwd);
  const deps: RunCriticDeps = {
    runToolsFn: async () => toolsWithFinding(),
    callBrainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
    writeCritiqueFn: async () => ({ id: "c-funnel", path: join(projectCwd, ".siltpoke", "fake.md") }),
  };

  await handleStopHook(stopEvent(sessionId, transcriptPath, projectCwd), {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
    m112Deps: deps,
    gitBranch: () => null,
    menubarDeps: { exec: () => {} },
  });

  return readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("live path: the telemetry row carries all four funnel stages, and they disagree", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
    // Cap at 2 so stage [3] is strictly below stage [2]; without this all three
    // counts would collapse to the same number and a swapped field would pass.
    writeFileSync(
      join(tmpHome, ".siltpoke", "config.json"),
      JSON.stringify({ memory: { maxRules: 2 } }),
    );
    await writeGlobal(join(tmpHome, ".siltpoke"), emptyGlobal());

    const mem = emptyMemory();
    mem.long_term_summary = "";
    mem.learned_rules = [
      rule("universal"),
      rule("ts-1", ["ts"]),
      rule("ts-2", ["ts"]),
      rule("py-only", ["py"]), // scope-filtered: the transcript only edits .ts
      rule("dead", undefined, "retired"), // never counted in the store
    ];
    await writeMemory(join(tmpHome, ".siltpoke"), mem, projectCwd);

    const rows = await runLiveStop(tmpHome, projectCwd, "sess-funnel");
    const fired = rows.find((r) => r.critic_path_decision !== undefined);
    expect(fired).toBeDefined();

    expect(fired!.rules_in_store).toBe(4); // retired excluded
    expect(fired!.rules_scope_matched).toBe(3); // py-only filtered out
    expect(fired!.rules_selected).toBe(2); // maxRules cap
    // Exact, not `> 0`: the two selected rules render as
    //   "  1. (misc) rule body for <id>\n  2. (misc) rule body for <id>"
    // and every id here is 2-9 chars, so the count is pinned by construction.
    // A wiring mutation that reported a wrong-but-positive constant would
    // survive a `> 0` assertion.
    const expectedBytes = Buffer.byteLength(
      ["universal", "ts-1"].map((id, i) => `  ${i + 1}. (misc) rule body for ${id}`).join("\n"),
      "utf8",
    );
    expect(fired!.rules_bytes_in_prompt).toBe(expectedBytes);

    // Per-section prompt sizes ride the SAME row and the same assembly. The
    // funnel's one size measures the rules listing only; these locate growth
    // in any of the other sections, which is what nothing could do when the
    // non-cached prompt tripled in early August.
    expect(fired!.prompt_bytes_total as number).toBeGreaterThan(0);
    expect(fired!.prompt_bytes_base as number).toBeGreaterThan(0);
    // The whole memory block is strictly larger than the rules listing inside
    // it — a wiring mutation that pointed `memory` at the listing would pass a
    // `> 0` check and fail this one.
    expect(fired!.prompt_bytes_memory as number).toBeGreaterThan(expectedBytes);
    // Every section is accounted for, and the total is not a sum of them.
    const parts = ["base", "memory", "recent", "tool_output", "caller_impact", "reverse_deps", "anti_examples"]
      .map((k) => fired![`prompt_bytes_${k}`] as number);
    for (const p of parts) expect(typeof p).toBe("number");
    expect(parts.reduce((a, b) => a + b, 0)).toBeLessThan(fired!.prompt_bytes_total as number);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("live path: an empty store reports measured zeros, not absent columns", async () => {
  // "We looked and there was nothing" must be distinguishable from "we never
  // looked" — that distinction is the entire diagnostic value of the funnel.
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-empty-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    await writeGlobal(join(tmpHome, ".siltpoke"), emptyGlobal());
    const mem = emptyMemory();
    mem.long_term_summary = "";
    mem.learned_rules = [];
    await writeMemory(join(tmpHome, ".siltpoke"), mem, projectCwd);

    const rows = await runLiveStop(tmpHome, projectCwd, "sess-funnel-empty");
    const fired = rows.find((r) => r.critic_path_decision !== undefined);
    expect(fired).toBeDefined();

    expect(fired).toHaveProperty("rules_in_store");
    expect(fired!.rules_in_store).toBe(0);
    expect(fired!.rules_scope_matched).toBe(0);
    expect(fired!.rules_selected).toBe(0);
    expect(fired!.rules_bytes_in_prompt).toBe(0);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("a run that never assembled a prompt reports NO funnel columns at all", async () => {
  // The load-bearing distinction: absent means "we never measured", zero means
  // "we measured and found nothing". If a suppressed-before-assembly row were
  // to emit zeros, every such row would read as "memory is empty" and the
  // funnel would re-create the exact ambiguity it was built to remove.
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-absent-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    await writeGlobal(join(tmpHome, ".siltpoke"), emptyGlobal());
    const mem = emptyMemory();
    mem.long_term_summary = "";
    mem.learned_rules = [rule("universal")];
    await writeMemory(join(tmpHome, ".siltpoke"), mem, projectCwd);

    const transcriptPath = seedTranscript(projectCwd);
    await handleStopHook(stopEvent("sess-absent", transcriptPath, projectCwd), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
      brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
      m112Deps: {
        // All-clean tools + no diff hunks => HARD_SUPPRESS before assembly.
        runToolsFn: async () => ({
          tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
          eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
          "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
          ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
          securityFindings: [],
          owaspHints: [],
          webSearchSources: [],
        }),
        callBrainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
      } as RunCriticDeps,
      gitBranch: () => null,
      menubarDeps: { exec: () => {} },
    });

    const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const suppressed = rows.find((r) => r.critic_path_decision === "HARD_SUPPRESS");
    expect(suppressed).toBeDefined();

    expect(suppressed).not.toHaveProperty("rules_in_store");
    expect(suppressed).not.toHaveProperty("rules_scope_matched");
    expect(suppressed).not.toHaveProperty("rules_selected");
    expect(suppressed).not.toHaveProperty("rules_bytes_in_prompt");
    // Same absent-vs-zero rule for the sizes: a run that never assembled must
    // not report a measured zero it did not measure.
    expect(suppressed).not.toHaveProperty("prompt_bytes_total");
    expect(suppressed).not.toHaveProperty("prompt_bytes_tool_output");
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("a run suppressed AFTER the prompt was built still reports its funnel", async () => {
  // The mirror of the previous test. A quota-cap refusal happens post-assembly:
  // the rules WERE selected and rendered, the provider just declined the call.
  // Dropping the columns here would misfile a provider problem as a memory
  // problem — the row would look identical to "no rules were ever injected".
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-capped-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    await writeGlobal(join(tmpHome, ".siltpoke"), emptyGlobal());
    const mem = emptyMemory();
    mem.long_term_summary = "";
    mem.learned_rules = [rule("universal"), rule("ts-1", ["ts"])];
    await writeMemory(join(tmpHome, ".siltpoke"), mem, projectCwd);

    const transcriptPath = seedTranscript(projectCwd);
    await handleStopHook(stopEvent("sess-capped", transcriptPath, projectCwd), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
      brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
      m112Deps: {
        runToolsFn: async () => toolsWithFinding(),
        callBrainFn: async (): Promise<BrainCallResult> => {
          throw new BrainError("daily cap reached", undefined, undefined, "quota_cap");
        },
      } as RunCriticDeps,
      gitBranch: () => null,
      menubarDeps: { exec: () => {} },
    });

    const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const capped = rows.find((r) => r.skipped === "quota_cap");
    expect(capped).toBeDefined();

    expect(capped!.rules_in_store).toBe(2);
    expect(capped!.rules_scope_matched).toBe(2);
    expect(capped!.rules_selected).toBe(2);
    expect(capped!.rules_bytes_in_prompt as number).toBeGreaterThan(0);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

/**
 * The two branches below exist because a reviewer pass caught that dropping the
 * funnel spread from the PASSIVE_BUBBLE row or the NORMAL-rejected row left the
 * whole suite green: those emit sites were wired but never exercised
 * end-to-end. A wired-but-unexercised emit site is exactly the failure this
 * track exists to eliminate — it is how `memory_rules_count` stayed dead for
 * 805 rows.
 */

function diffOnlyTools(): Record<ToolName, ToolResult> & {
  securityFindings: never[];
  owaspHints: never[];
  webSearchSources: never[];
} {
  // Clean checkers but a real diff hunk => PASSIVE_BUBBLE (nothing to flag,
  // but the user did change code, so the pet still speaks).
  return {
    tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": {
      tool: "git-diff",
      status: "ok",
      // The gate reads `parsed`, not `raw` — an empty parsed array reads as
      // "nothing changed" and HARD_SUPPRESSes before assembly.
      parsed: [
        {
          file: "dummy.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          body: "-export const dummy = 1;\n+export const dummy = 2;",
        },
      ],
      raw: "diff --git a/dummy.ts b/dummy.ts\n@@ -1 +1 @@\n-export const dummy = 1;\n+export const dummy = 2;\n",
    },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

async function seedTwoRules(tmpHome: string, projectCwd: string): Promise<void> {
  await writeGlobal(join(tmpHome, ".siltpoke"), emptyGlobal());
  const mem = emptyMemory();
  mem.long_term_summary = "";
  mem.learned_rules = [rule("universal"), rule("ts-1", ["ts"]), rule("py-only", ["py"])];
  await writeMemory(join(tmpHome, ".siltpoke"), mem, projectCwd);
}

function readRows(tmpHome: string): Record<string, unknown>[] {
  return readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("PASSIVE_BUBBLE rows carry the funnel too", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-pb-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    await seedTwoRules(tmpHome, projectCwd);
    const transcriptPath = seedTranscript(projectCwd);

    await handleStopHook(stopEvent("sess-pb", transcriptPath, projectCwd), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
      brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
      m112Deps: {
        runToolsFn: async () => diffOnlyTools(),
        // No evidence: a passive bubble is commentary, not a finding.
        callBrainFn: async (): Promise<BrainCallResult> => ({
          output: { ...fakeBrainOutput(), severity: "info", critique_for_claude: "", evidence: [] },
          usage: noopUsage,
        }),
        writeCritiqueFn: async () => ({ id: "c-pb", path: join(projectCwd, ".siltpoke", "fake.md") }),
      } as RunCriticDeps,
      gitBranch: () => null,
      menubarDeps: { exec: () => {} },
    });

    const row = readRows(tmpHome).find((r) => r.critic_path_decision === "PASSIVE_BUBBLE");
    expect(row).toBeDefined();
    expect(row!.rules_in_store).toBe(3);
    expect(row!.rules_scope_matched).toBe(2); // py-only filtered out
    expect(row!.rules_bytes_in_prompt as number).toBeGreaterThan(0);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("NORMAL rows with unverified evidence carry the funnel too", async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-rej-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    await seedTwoRules(tmpHome, projectCwd);
    const transcriptPath = seedTranscript(projectCwd);

    await handleStopHook(stopEvent("sess-rej", transcriptPath, projectCwd), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
      brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
      m112Deps: {
        runToolsFn: async () => toolsWithFinding(),
        // Evidence snippet that appears nowhere in the tool corpus => the
        // citation is dropped and the row is NORMAL/accepted=true carrying
        // `m112_evidence_label: "none_verified"`. Before 2026-08-19 the whole
        // review died here and the row was accepted=false; the funnel had to
        // survive that, and it has to survive this.
        callBrainFn: async (): Promise<BrainCallResult> => ({
          output: {
            ...fakeBrainOutput(),
            evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: "THIS TEXT IS NOWHERE IN THE CORPUS" }],
          },
          usage: noopUsage,
        }),
        writeCritiqueFn: async () => ({ id: "c-rej", path: join(projectCwd, ".siltpoke", "fake.md") }),
      } as RunCriticDeps,
      gitBranch: () => null,
      menubarDeps: { exec: () => {} },
    });

    const row = readRows(tmpHome).find((r) => r.m112_evidence_label === "none_verified");
    expect(row).toBeDefined();
    // Pin the row's own shape before reading the funnel off it — otherwise a
    // future change that stopped writing the label would just make `find`
    // match some other row and the funnel assertions would pass on it.
    expect(row!.m112_accepted).toBe(true);
    expect(row!.m112_evidence_unverified).toBe(1);
    expect(row!.rules_in_store).toBe(3);
    expect(row!.rules_scope_matched).toBe(2);
    expect(row!.rules_bytes_in_prompt as number).toBeGreaterThan(0);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("a Brain call that fails outright still reports the funnel it had built", async () => {
  // Same reasoning as the quota_cap case, one rung more general: the prompt was
  // assembled, the call blew up. Without the funnel this row is
  // indistinguishable from "memory never reached the prompt", which would send
  // an investigation down the wrong branch.
  const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-funnel-brainfail-"));
  try {
    const projectCwd = join(tmpHome, "proj");
    // Git-init BEFORE anything resolves a project root — creating `.git`
    // moves that root, and per-repo memory is keyed on it.
    makeGitRepo(projectCwd);
    await seedTwoRules(tmpHome, projectCwd);
    const transcriptPath = seedTranscript(projectCwd);

    await handleStopHook(stopEvent("sess-brainfail", transcriptPath, projectCwd), {
      env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
      brainFn: async (): Promise<BrainCallResult> => ({ output: fakeBrainOutput(), usage: noopUsage }),
      m112Deps: {
        runToolsFn: async () => toolsWithFinding(),
        callBrainFn: async (): Promise<BrainCallResult> => {
          throw new BrainError("subprocess exited 1");
        },
      } as RunCriticDeps,
      gitBranch: () => null,
      menubarDeps: { exec: () => {} },
    });

    const row = readRows(tmpHome).find(
      (r) => r.critic_path_decision === "HARD_SUPPRESS" && r.skipped === undefined,
    );
    expect(row).toBeDefined();
    expect(row!.rules_in_store).toBe(3);
    expect(row!.rules_scope_matched).toBe(2);
    expect(row!.rules_bytes_in_prompt as number).toBeGreaterThan(0);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
