/**
 * Tests for handleStopHook.
 *
 * Part 1: Regression — legacy baseline behavior unchanged when flag OFF.
 * Part 2: tool-augmented path — SILTPOKE_TOOL_AUGMENTED=1 exercises runCritic.
 *
 * These tests directly import handleStopHook (not runHook from on-stop.ts)
 * to test the core logic in isolation of the suppression marker layer.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import type { BrainOutput } from "../../src/brain/schema";
import type { CallBrainOptions, BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import type { ConsolidateOpts, ConsolidateResult } from "../../src/memory/consolidate";
import { writeMemory, emptyMemory } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hsh-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeTranscriptWithEdit(dir: string, filePath?: string): string {
  // Edit an absolute path to a file we actually create, so the Stop hook's
  // pruneMissing (drops transcript paths gone from disk) keeps it — otherwise
  // a relative fake path resolves to a non-existent file and the hook skips.
  const editedPath = filePath ?? join(dir, "dummy.ts");
  if (!filePath) writeFileSync(editedPath, "export const dummy = 1;\n");
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", name: "Edit", input: { file_path: editedPath } },
        ],
      },
    })}\n`,
  );
  return transcriptPath;
}

function makeStopEvent(
  sessionId: string,
  transcriptPath: string,
  cwd: string,
): HookEvent {
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  };
}

const noopUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

function makeFakeBrainOutput(overrides?: Partial<BrainOutput>): BrainOutput {
  return {
    mood: "happy",
    pose: "base",
    bubble_short: "ok",
    bubble_long: "",
    critique_for_claude: "something actionable",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1: legacy regression — flag OFF (default)
// ---------------------------------------------------------------------------

describe("handleStopHook — legacy baseline (flag OFF)", () => {
  // The default was later flipped to ON — these legacy regressions explicitly
  // opt out via SILTPOKE_TOOL_AUGMENTED=0 so the legacy path stays
  // covered.
  const legacyEnv = { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" };

  test("Brain called and state written when flag is OFF", async () => {
    const projectCwd = join(tmpHome, "proj");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let brainCalled = false;
    const fakeBrain: BrainOutput = makeFakeBrainOutput();

    await handleStopHook(
      makeStopEvent("sess-baseline", transcriptPath, projectCwd),
      {
        env: legacyEnv,
        brainFn: async (_opts: CallBrainOptions): Promise<BrainCallResult> => {
          brainCalled = true;
          return { output: fakeBrain, usage: noopUsage };
        },
      },
    );

    expect(brainCalled).toBe(true);
    // state.json written
    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(true);
  });

  test("tool-augmented env var explicitly OFF → legacy path (brainFn called directly)", async () => {
    const projectCwd = join(tmpHome, "proj2");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let m112RunCriticCalled = false;
    let m11brainCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => {
        m112RunCriticCalled = true;
        // return something to avoid crash, but this shouldn't be called
        return {
          tsc: { tool: "tsc" as const, status: "not_applicable" as const, parsed: [], raw: "" },
          eslint: { tool: "eslint" as const, status: "not_applicable" as const, parsed: [], raw: "" },
          "git-diff": { tool: "git-diff" as const, status: "not_applicable" as const, parsed: [], raw: "" },
          ripgrep: { tool: "ripgrep" as const, status: "not_applicable" as const, parsed: [], raw: "" },
          securityFindings: [] as never[],
          owaspHints: [] as never[],
        webSearchSources: [],
        };
      },
    };

    await handleStopHook(
      makeStopEvent("sess-no-flag", transcriptPath, projectCwd),
      {
        env: legacyEnv,
        brainFn: async (): Promise<BrainCallResult> => {
          m11brainCalled = true;
          return { output: makeFakeBrainOutput(), usage: noopUsage };
        },
        m112Deps: deps,
      },
    );

    expect(m11brainCalled).toBe(true);
    expect(m112RunCriticCalled).toBe(false);
  });

  test("confidence=high severity=medium → critique written (regression)", async () => {
    const projectCwd = join(tmpHome, "proj3");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    await handleStopHook(
      makeStopEvent("sess-critique", transcriptPath, projectCwd),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput({
            severity: "medium",
            confidence: "high",
          }),
          usage: noopUsage,
        }),
      },
    );

    const today = new Date().toISOString().slice(0, 10);
    const archiveDir = join(projectCwd, ".siltpoke", "critiques", "archive", today);
    expect(existsSync(archiveDir)).toBe(true);
  });

  // Characterization FLIPPED 2026-06-11: previously asserted
  // state.json written with bubble_short "" — empty effective bubble now
  // skips the state write entirely.
  test("confidence=low → empty-bubble state write skipped", async () => {
    const projectCwd = join(tmpHome, "proj4");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    await handleStopHook(
      makeStopEvent("sess-low", transcriptPath, projectCwd),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput({
            mood: "idle",
            bubble_short: "should not appear",
            severity: "info",
            confidence: "low",
          }),
          usage: noopUsage,
        }),
      },
    );

    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2: tool-augmented path — SILTPOKE_TOOL_AUGMENTED=1
// ---------------------------------------------------------------------------

describe("handleStopHook — tool-augmented path (flag ON)", () => {
  const m112Env = (homeDir: string): NodeJS.ProcessEnv => ({
    HOME: homeDir,
    SILTPOKE_TOOL_AUGMENTED: "1",
  });

  function makeAllNotApplicable(): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
    return {
      tsc: { tool: "tsc", status: "not_applicable", parsed: [], raw: "" },
      eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
      "git-diff": { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" },
      ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    };
  }

  function makeWithTscError(snippet: string): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
    return {
      tsc: {
        tool: "tsc",
        status: "ok",
        parsed: [
          {
            file: "src/dummy.ts",
            line: 5,
            col: 1,
            severity: "error",
            code: "TS2322",
            message: "Type mismatch.",
          },
        ],
        raw: `src/dummy.ts(5,1): error TS2322\n${snippet}`,
      },
      eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
      "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
      ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    };
  }

  test("tool-augmented flag ON + HARD_SUPPRESS → log entry has critic_path_decision, no Brain call", async () => {
    const projectCwd = join(tmpHome, "m112-suppress");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let m11brainCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeAllNotApplicable(),
      callBrainFn: async (): Promise<BrainCallResult> => {
        m11brainCalled = true;
        return { output: makeFakeBrainOutput(), usage: noopUsage };
      },
      writeCritiqueFn: async () => ({ id: "c-suppress", path: "/tmp" }),
    };

    await handleStopHook(
      makeStopEvent("sess-m112-suppress", transcriptPath, projectCwd),
      {
        env: m112Env(tmpHome),
        brainFn: async (): Promise<BrainCallResult> => {
          m11brainCalled = true;
          return { output: makeFakeBrainOutput(), usage: noopUsage };
        },
        m112Deps: deps,
      },
    );

    expect(m11brainCalled).toBe(false);

    const log = readFileSync(
      join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
      "utf8",
    );
    expect(log).toContain("critic_path_decision");
    expect(log).toContain("HARD_SUPPRESS");
  });

  test("tool-augmented flag ON + NORMAL accepted → state written, log shows tool-augmented critic", async () => {
    const projectCwd = join(tmpHome, "m112-normal");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const REAL_SNIPPET = "const x: string = 42;";

    let writeCritiqueCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(REAL_SNIPPET),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput({
          mood: "annoyed",
          bubble_short: "Type error found",
          severity: "medium",
          confidence: "high",
          evidence: [
            {
              tool: "tsc",
              file: "src/dummy.ts",
              line: 5,
              snippet: REAL_SNIPPET,
            },
          ],
        }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async (_basePath, _input) => {
        writeCritiqueCalled = true;
        return { id: "c-m112-normal", path: join(projectCwd, ".siltpoke", "fake.md") };
      },
    };

    await handleStopHook(
      makeStopEvent("sess-m112-normal", transcriptPath, projectCwd),
      {
        env: m112Env(tmpHome),
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        m112Deps: deps,
      },
    );

    expect(writeCritiqueCalled).toBe(true);

    // State should be written by the NORMAL accepted path
    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(true);

    const log = readFileSync(
      join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
      "utf8",
    );
    expect(log).toContain("m112_path");
    expect(log).toContain("NORMAL");
  });

  test("tool-augmented flag ON + NORMAL guard rejected → no writeCritique, log shows rejected", async () => {
    const projectCwd = join(tmpHome, "m112-rejected");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let writeCritiqueCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError("real snippet here in raw output"),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput({
          evidence: [
            {
              tool: "tsc",
              file: "src/dummy.ts",
              line: 5,
              snippet: "fabricated hallucination snippet XYZ",
            },
          ],
        }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async () => {
        writeCritiqueCalled = true;
        return { id: "c-rejected", path: "/tmp" };
      },
    };

    await handleStopHook(
      makeStopEvent("sess-m112-rejected", transcriptPath, projectCwd),
      {
        env: m112Env(tmpHome),
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        m112Deps: deps,
      },
    );

    expect(writeCritiqueCalled).toBe(false);

    const log = readFileSync(
      join(tmpHome, ".siltpoke", "brain-calls.jsonl"),
      "utf8",
    );
    expect(log).toContain("m112_accepted");
    expect(log).toContain("false");
  });

  test("F4: tool-augmented flag ON + NORMAL accepted → appendUsageEvent written with Brain usage tokens", async () => {
    // Verifies that runCritic Brain tokens are not silently dropped — the daily
    // budget rollup must see them or it will under-count and over-invoke.
    const projectCwd = join(tmpHome, "m112-usage");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const REAL_SNIPPET = "const x: string = 42;";
    const USAGE = {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.005,
    };

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: {
          tool: "tsc" as const,
          status: "ok" as const,
          parsed: [
            {
              file: "src/dummy.ts",
              line: 5,
              col: 1,
              severity: "error" as const,
              code: "TS2322",
              message: "Type mismatch.",
            },
          ],
          raw: `src/dummy.ts(5,1): error TS2322\n${REAL_SNIPPET}`,
        },
        eslint: { tool: "eslint" as const, status: "not_applicable" as const, parsed: [], raw: "" },
        "git-diff": { tool: "git-diff" as const, status: "ok" as const, parsed: [], raw: "" },
        ripgrep: { tool: "ripgrep" as const, status: "ok" as const, parsed: [], raw: "" },
        securityFindings: [] as never[],
        owaspHints: [] as never[],
        webSearchSources: [],
      }),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput({
          mood: "annoyed",
          severity: "medium",
          confidence: "high",
          evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
        }),
        usage: USAGE,
      }),
      writeCritiqueFn: async () => ({ id: "c-f4", path: join(projectCwd, ".siltpoke", "fake.md") }),
    };

    await handleStopHook(
      makeStopEvent("sess-f4-usage", transcriptPath, projectCwd),
      {
        env: m112Env(tmpHome),
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        m112Deps: deps,
      },
    );

    // appendUsageEvent writes to homeBase/usage-events.jsonl
    const usageEventsPath = join(tmpHome, ".siltpoke", "usage-events.jsonl");
    expect(existsSync(usageEventsPath)).toBe(true);

    const usageRaw = readFileSync(usageEventsPath, "utf8");
    const usageLines = usageRaw.trim().split("\n").filter(Boolean);
    expect(usageLines.length).toBeGreaterThan(0);

    const lastEvent = JSON.parse(usageLines[usageLines.length - 1]!);
    expect(lastEvent.input_tokens).toBe(USAGE.input_tokens);
    expect(lastEvent.output_tokens).toBe(USAGE.output_tokens);
    expect(lastEvent.total_cost_usd).toBe(USAGE.total_cost_usd);
    expect(lastEvent.session_id).toBe("sess-f4-usage");
    expect(lastEvent.kind).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Part 3: consolidate() wired into handleStopHook
//
// Uses consolidateFn injection so no real API calls are made.
// ---------------------------------------------------------------------------

describe("handleStopHook — consolidate integration", () => {
  test("stub consolidate returns ran:false → hook completes without crash, state written", async () => {
    const projectCwd = join(tmpHome, "m114-gate-miss");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let consolidateCalled = false;
    let seenProjectBase: string | undefined;
    const stubConsolidate = async (opts: ConsolidateOpts): Promise<ConsolidateResult> => {
      consolidateCalled = true;
      seenProjectBase = opts.projectBase;
      return { ran: false, reason: "trigger gate not satisfied" };
    };

    await handleStopHook(
      makeStopEvent("sess-m114-gate-miss", transcriptPath, projectCwd),
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({
          output: makeFakeBrainOutput(),
          usage: noopUsage,
        }),
        consolidateFn: stubConsolidate,
      },
    );

    expect(consolidateCalled).toBe(true);
    // memory-capture-repair: handleStopHook must pass projectBase = repo-local
    // .siltpoke so consolidate reads project-local critiques (not stale global).
    expect(seenProjectBase).toBe(join(projectCwd, ".siltpoke"));
    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(true);
  });

  test("stub consolidate returns ran:true → hook completes, summary logged (no crash)", async () => {
    const projectCwd = join(tmpHome, "m114-ran-true");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const stubConsolidate = async (_opts: ConsolidateOpts): Promise<ConsolidateResult> => ({
      ran: true,
      candidates: 3,
      apply: { added: 2, updated: 0, retired: 1, skipped: 0, discarded: 0 },
      decay: { proposed: 0 },
      prune: { factsPruned: 1, pendingPruned: 0 },
      eventFragments: 0,
      episodesSynthesized: 0,
      durationMs: 120,
    });

    await expect(
      handleStopHook(
        makeStopEvent("sess-m114-ran-true", transcriptPath, projectCwd),
        {
          env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
          brainFn: async (): Promise<BrainCallResult> => ({
            output: makeFakeBrainOutput(),
            usage: noopUsage,
          }),
          consolidateFn: stubConsolidate,
        },
      ),
    ).resolves.toBeUndefined(); // must not throw

    // state.json written by main critic path
    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(true);
  });

  test("stub consolidate throws → hook still completes (error is swallowed)", async () => {
    const projectCwd = join(tmpHome, "m114-throw");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const stubConsolidate = async (_opts: ConsolidateOpts): Promise<ConsolidateResult> => {
      throw new Error("unexpected consolidate crash");
    };

    await expect(
      handleStopHook(
        makeStopEvent("sess-m114-throw", transcriptPath, projectCwd),
        {
          env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
          brainFn: async (): Promise<BrainCallResult> => ({
            output: makeFakeBrainOutput(),
            usage: noopUsage,
          }),
          consolidateFn: stubConsolidate,
        },
      ),
    ).resolves.toBeUndefined(); // must not throw despite consolidate throwing

    // state.json still written
    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// no_code_changes first-touch acknowledgement (sq-nocode-noop, day-1)
// ---------------------------------------------------------------------------

function makeTranscriptNoEdit(dir: string): string {
  // Assistant turn with only text — no tool_use — so extractChangedFiles
  // returns [] and the no_code_changes gate fires.
  const transcriptPath = join(dir, "transcript-nocode.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "just chatting, no edits" }] },
    })}\n`,
  );
  return transcriptPath;
}

describe("handleStopHook — no_code_changes first-touch acknowledgement", () => {
  test("first no-code stop (pet never reacted) writes an ambient welcome state", async () => {
    const projectCwd = join(tmpHome, "proj");
    const transcriptPath = makeTranscriptNoEdit(tmpHome);

    await handleStopHook(
      makeStopEvent("sess-firsttouch", transcriptPath, projectCwd),
      { env: { HOME: tmpHome } },
    );

    const statePath = join(projectCwd, ".siltpoke", "state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    // Visible ambient acknowledgement — a non-empty bubble, not a silent cliff.
    expect(state.bubble_short.length).toBeGreaterThan(0);
  });

  test("no-code stop stays silent once the pet already has state (no nag)", async () => {
    const projectCwd = join(tmpHome, "proj");
    const stateDir = join(projectCwd, ".siltpoke");
    const statePath = join(stateDir, "state.json");
    // Seed a prior state as if the pet had already reacted before.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        mood: "happy",
        pose: "base",
        bubble_short: "prior bubble",
        severity: "info",
        confidence: "high",
        last_updated_ms: Date.now(),
        last_session_id: "prior",
      }),
    );
    const before = readFileSync(statePath, "utf8");

    const transcriptPath = makeTranscriptNoEdit(tmpHome);
    await handleStopHook(
      makeStopEvent("sess-steady", transcriptPath, projectCwd),
      { env: { HOME: tmpHome } },
    );

    // Unchanged — no welcome overwrite, no nag.
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});

describe("handleStopHook — V3 store memory read", () => {
  test("critic injects facts from the V3 store (homeBase), not the empty per-repo base", async () => {
    const homeSilt = join(tmpHome, ".siltpoke");
    mkdirSync(homeSilt, { recursive: true });
    // global.json presence flips readMemory/writeMemory to V3 (per-project scoped
    // internally on resolveProjectRoot(process.cwd())).
    await writeGlobal(homeSilt, emptyGlobal());
    const mem = emptyMemory();
    mem.facts = [
      {
        id: "f-seed",
        text: "SEEDED_FACT_ABC",
        source_session_id: null,
        confidence: 1,
        status: "active",
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        supersedes: null,
        recall_count: 0,
        kind: "style",
        learned_from: { stream: "user", session_id: null },
      } as any,
    ];
    await writeMemory(homeSilt, mem);

    let captured = "";
    await handleStopHook(
      makeStopEvent("sess-v3", makeTranscriptWithEdit(tmpHome), process.cwd()),
      {
        // Tool-augmented path is irrelevant here and would run real
        // tsc/eslint against the actual repo since event.cwd = process.cwd();
        // force the legacy baseline path (inline brain call) instead.
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
          captured = JSON.stringify(opts);
          return { output: makeFakeBrainOutput(), usage: noopUsage };
        },
      },
    );
    expect(captured).toContain("SEEDED_FACT_ABC");
  });
});

describe("handleStopHook — per-event-repo memory scoping (HIGH finding fix)", () => {
  // The daemon's process.cwd() is frozen at daemon-launch time, but the
  // Stop-hook fires once per repo (event.cwd). The critic must read the V3
  // memory slice for event.cwd, not the daemon's own process.cwd() — else
  // multi-repo users sharing one daemon get cross-project memory bleed.
  test("critic injects facts scoped to event.cwd, not the daemon's process.cwd()", async () => {
    const homeSilt = join(tmpHome, ".siltpoke");
    mkdirSync(homeSilt, { recursive: true });
    await writeGlobal(homeSilt, emptyGlobal());

    // A repo distinct from process.cwd() (the test runner's repo root).
    const eventCwd = mkdtempSync(join(tmpdir(), "siltpoke-hsh-eventcwd-"));
    try {
      const mem = emptyMemory();
      mem.facts = [
        {
          id: "f-eventcwd",
          text: "EVENTCWD_SCOPED_FACT",
          source_session_id: null,
          confidence: 1,
          status: "active",
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          supersedes: null,
          recall_count: 0,
          kind: "style",
          learned_from: { stream: "user", session_id: null },
        } as any,
      ];
      // Seed the fact keyed to eventCwd's project slice specifically.
      await writeMemory(homeSilt, mem, eventCwd);

      let captured = "";
      await handleStopHook(
        makeStopEvent("sess-eventcwd", makeTranscriptWithEdit(tmpHome), eventCwd),
        {
          // Force the legacy baseline path (inline brain call) — the
          // tool-augmented path is irrelevant to memory scoping.
          env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
          brainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
            captured = JSON.stringify(opts);
            return { output: makeFakeBrainOutput(), usage: noopUsage };
          },
        },
      );
      expect(captured).toContain("EVENTCWD_SCOPED_FACT");
    } finally {
      rmSync(eventCwd, { recursive: true, force: true });
    }
  });
});
