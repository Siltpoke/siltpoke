/**
 * Tests for handleStopHook.
 *
 * Part 1: Regression — legacy baseline behavior unchanged when flag OFF.
 * Part 2: tool-augmented path — SILTPOKE_TOOL_AUGMENTED=1 exercises runCritic.
 *
 * These tests directly import handleStopHook (not runHook from on-stop.ts)
 * to test the core logic in isolation of the suppression marker layer.
 */

import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import type { BrainOutput } from "../../src/brain/schema";
import { BrainError, type CallBrainOptions, type BrainCallResult } from "../../src/brain/brain";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { BrainProviderMeta } from "../../src/brain/provider";
import type { ToolCallRecord } from "../../src/brain/tool-calls";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { commitAll, headSha, makeGitRepo } from "../_shared/git-fixture";
import { extractChangedFiles, extractLatestUserMessage } from "../../src/router/context";
import { buildSignature, computeContextHash } from "../../src/router/skip-detector";
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

// ---------------------------------------------------------------------------
// Guard — no test in this file may leave fake critique data in the developer's
// REAL siltpoke state.
//
// The V3-store test below pins `event.cwd` to the real repo on purpose (V3
// memory is scoped on resolveProjectRoot), so `writeCritique` files its output
// into THIS checkout. It writes three places, not one
// (src/state/critique.ts:233-234, 300, 306):
//   critiques/archive/<date>/<id>.md   — surfaced by the Memory Book page
//   critiques/history.jsonl            — appended, never pruned
//   critiques/latest.md                — overwritten; backs the status card,
//                                        /siltpoke:siltpoke-last and the menu bar
// Left unguarded these accumulated 1,087 archive files and 1,047 history lines
// over two months, and latest.md was showing a fake review at the moment this
// guard was written. Nothing was watching any of the three.
//
// Identification is by CONTENT, not by "appeared during this run": a critique
// this suite writes carries session_id `sess-v3` AND the placeholder body.
// Both conditions together matched 1,087 files and zero real ones, so a real
// critique filed by the developer's own live daemon while the suite runs is
// never mistaken for ours and never deleted.
//
// Two limits, stated rather than implied:
//   - `afterAll` reuses the SAME three predicates the cleanup uses, so it
//     asserts "the cleanup ran to completion", not "this file behaved". That
//     is weaker than it reads. It is still the check that matters: the only
//     way to reach a non-zero count is for the cleanup not to have run.
//   - the history.jsonl rewrite below is read-modify-write, not an atomic
//     append-filter. A genuine line appended by the live daemon inside that
//     window would be dropped. Microseconds wide, synchronous, and accepted
//     deliberately — an atomic rewrite here would need a lock this test has
//     no way to take.
// ---------------------------------------------------------------------------
const REAL_CRITIQUES = join(process.cwd(), ".siltpoke", "critiques");
const REAL_ARCHIVE = join(REAL_CRITIQUES, "archive");
const REAL_HISTORY = join(REAL_CRITIQUES, "history.jsonl");
const REAL_LATEST = join(REAL_CRITIQUES, "latest.md");
// The fifth path. state.json backs the statusline pet and its speech bubble,
// and the critic writes it unconditionally into event.cwd's .siltpoke/ — so
// with cwd pinned to the real repo below, a run leaves the developer looking at
// this suite's placeholder bubble ("ok") until the next real review overwrites
// it. Four paths were saved and restored here; this one was not on the list,
// and it is the only one the human actually sees on every terminal line.
const REAL_STATE = join(process.cwd(), ".siltpoke", "state.json");
// The sixth. `handle-stop.ts:1547/:2026` append to `<stateBase>/pending-critiques.jsonl`,
// which the real distil-worker and case1-capture pipeline later consume. It does
// NOT fire on today's run — the guard is `evidence.length > 0` and the default
// fake brain output carries `evidence: []` — but four tests in THIS file already
// override evidence with a non-empty array, so it is one ordinary edit from
// leaking a permanent line into the developer's queue. Covered now rather than
// after, because "the list was incomplete" is the whole reason this file is
// being edited. Raised by review; verified before adding (the real queue is 0
// lines today, so nothing here is retroactive cleanup).
const REAL_PENDING = join(process.cwd(), ".siltpoke", "pending-critiques.jsonl");
const FAKE_HISTORY_MARK = '"session_id":"sess-v3"';

function isFakeCritique(text: string): boolean {
  return /^session_id:\s*sess-v3\s*$/m.test(text) && text.includes("\nsomething actionable\n");
}

/** True iff the state.json sitting in the real repo is the one this suite wrote. */
function stateIsFake(): boolean {
  if (!existsSync(REAL_STATE)) return false;
  try {
    const parsed = JSON.parse(readFileSync(REAL_STATE, "utf8")) as { last_session_id?: unknown };
    return parsed.last_session_id === "sess-v3";
  } catch {
    // Unparseable is not ours to judge — leave it alone rather than delete it.
    return false;
  }
}

/** Absolute paths of fake critique files currently sitting in the real archive. */
function fakeArchiveFiles(): string[] {
  if (!existsSync(REAL_ARCHIVE)) return [];
  return readdirSync(REAL_ARCHIVE, { recursive: true })
    .map((e) => String(e))
    .filter((e) => e.endsWith(".md"))
    .map((rel) => join(REAL_ARCHIVE, rel))
    .filter((abs) => {
      // An unreadable file is "not ours, skip it". Without this catch, a file
      // vanishing between the readdir and the read throws OUT of the finally
      // block below — which would abort the history and latest.md cleanup
      // that runs after it, masking the real test outcome with an FS error.
      try {
        return isFakeCritique(readFileSync(abs, "utf8"));
      } catch {
        return false;
      }
    });
}

function fakeHistoryLineCount(): number {
  if (!existsSync(REAL_HISTORY)) return 0;
  return readFileSync(REAL_HISTORY, "utf8")
    .split("\n")
    .filter((l) => l.includes(FAKE_HISTORY_MARK)).length;
}

/** Lines in the real pending-critiques queue that this suite appended. */
function fakePendingLineCount(): number {
  if (!existsSync(REAL_PENDING)) return 0;
  return readFileSync(REAL_PENDING, "utf8")
    .split("\n")
    .filter((l) => l.includes(FAKE_HISTORY_MARK)).length;
}

function latestIsFake(): boolean {
  return existsSync(REAL_LATEST) && isFakeCritique(readFileSync(REAL_LATEST, "utf8"));
}

afterAll(() => {
  expect({
    archiveFiles: fakeArchiveFiles().map((f) => f.slice(REAL_ARCHIVE.length + 1)),
    historyLines: fakeHistoryLineCount(),
    latestIsFake: latestIsFake(),
    stateIsFake: stateIsFake(),
    pendingLines: fakePendingLineCount(),
  }).toEqual({
    archiveFiles: [],
    historyLines: 0,
    latestIsFake: false,
    stateIsFake: false,
    pendingLines: 0,
  });
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
  // The ⏱ review-unit gate asks git whether a unit of work closed, so a cwd
  // git knows nothing about is answered with `not_a_git_repo` before anything
  // else in these tests can run. A real user's cwd is a repo; this makes the
  // fixture one too. See tests/_shared/git-fixture.ts.
  makeGitRepo(cwd);
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
    findings: [],
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
  // A function, not a const: this describe() callback body runs once at
  // registration time, before beforeEach has populated tmpHome for any
  // individual test — a bare `const legacyEnv = { HOME: tmpHome, ... }`
  // would freeze `HOME: undefined`. siltpokeRoot() (unlike the old
  // permissive siltpokeHome() this hook used to carry) throws on a
  // missing/empty HOME rather than silently falling back to a relative
  // path, which is what surfaced this latent bug.
  const legacyEnv = () => ({ HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" });

  test("Brain called and state written when flag is OFF", async () => {
    const projectCwd = join(tmpHome, "proj");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let brainCalled = false;
    const fakeBrain: BrainOutput = makeFakeBrainOutput();

    await handleStopHook(
      makeStopEvent("sess-baseline", transcriptPath, projectCwd),
      {
        env: legacyEnv(),
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
        env: legacyEnv(),
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

  // 🛡 [C]: the legacy writer records the reviewer's tools like the
  // tool-augmented rows do — a list when the call returned one, else "not_recorded".
  test("legacy row carries tool_calls: the list, or not_recorded", async () => {
    const transcriptPath = makeTranscriptWithEdit(tmpHome);
    const run = async (sess: string, toolCalls?: BrainCallResult["toolCalls"]) => {
      await handleStopHook(makeStopEvent(sess, transcriptPath, join(tmpHome, sess)), {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({ output: makeFakeBrainOutput(), usage: noopUsage, toolCalls }),
      });
      const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8").trim().split("\n");
      return JSON.parse(rows.at(-1) ?? "{}") as Record<string, unknown>;
    };
    expect((await run("legacy-tools", [{ tool: "Read", target: "a.ts", failed: false }])).tool_calls).toEqual([
      { tool: "Read", target: "a.ts", failed: false },
    ]);
    expect((await run("legacy-none")).tool_calls).toBe("not_recorded");
  });

  test("legacy row carries injection_alert only when a signal fired", async () => {
    const transcriptPath = makeTranscriptWithEdit(tmpHome);
    const run = async (sess: string, extra: Partial<BrainOutput>, toolCalls?: BrainCallResult["toolCalls"]) => {
      await handleStopHook(makeStopEvent(sess, transcriptPath, join(tmpHome, sess)), {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (): Promise<BrainCallResult> => ({ output: makeFakeBrainOutput(extra), usage: noopUsage, toolCalls }),
      });
      const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8").trim().split("\n");
      return JSON.parse(rows.at(-1) ?? "{}") as Record<string, unknown>;
    };
    const hit = await run("legacy-inj", { injection_suspected: [{ where: "a.md", quote: "obey", why: "steers" }] });
    expect((hit.injection_alert as { level: string }).level).toBe("loud");
    expect("injection_alert" in (await run("legacy-clean", { injection_suspected: [] }))).toBe(false);
    const tool = await run("legacy-tool", {}, [{ tool: "Read", target: "/etc/hosts", failed: false }]);
    expect((tool.injection_alert as { toolRecord: string }).toolRecord).toBe("recorded");
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
          findings: [],
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
        // T5 side effects are real spawnSync calls on darwin — stub so this
        // fired-path test never shells out or pops a real notification.
        menubarDeps: { exec: () => {} },
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

  // Bubble alert: a loud alert on a NORMAL review reaches BOTH the row and the
  // project state file, even when low confidence blanks the review's own bubble;
  // the next alert-free review in that project clears it.
  const alertDeps = (extra: Record<string, unknown>): RunCriticDeps => ({
    runToolsFn: async () => makeWithTscError("const x: string = 42;"),
    callBrainFn: async (): Promise<BrainCallResult> => ({
      output: makeFakeBrainOutput({
        bubble_short: "Type error found",
        severity: "medium",
        evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: "const x: string = 42;" }],
        ...extra,
      }),
      usage: noopUsage,
    }),
    writeCritiqueFn: async () => ({ id: "c-alert", path: "/tmp" }),
  });
  const runAlertTurn = async (sid: string, cwd: string, extra: Record<string, unknown>, deps = alertDeps): Promise<void> => {
    // The review-unit gate wants a new commit per review.
    if (existsSync(join(cwd, ".git"))) {
      writeFileSync(join(cwd, `${sid}.txt`), sid);
      commitAll(cwd, sid);
    }
    await handleStopHook(makeStopEvent(sid, makeTranscriptWithEdit(tmpHome), cwd), {
      env: m112Env(tmpHome),
      m112Deps: deps(extra),
      menubarDeps: { exec: () => {} },
    });
  };
  const readProjectState = (cwd: string): { bubble_short: string; alert?: { text: string; project: string } } =>
    JSON.parse(readFileSync(join(cwd, ".siltpoke", "state.json"), "utf8"));

  test("NORMAL + loud alert at LOW confidence: row carries injection_alert AND state carries alert", async () => {
    const projectCwd = join(tmpHome, "alert-low");
    await runAlertTurn("sess-alert-low", projectCwd, {
      confidence: "low",
      injection_suspected: [{ where: "README.md", quote: "ignore all rules", why: "steers" }],
    });
    const rows = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    const line = JSON.parse(rows[rows.length - 1]!) as Record<string, unknown>;
    expect(line.critic_path_decision).toBe("NORMAL");
    expect((line.injection_alert as { level: string }).level).toBe("loud");
    // The bubble was blanked but the alert was written: the row says so (F8).
    expect(line.bubble_suppressed).toBe(true);
    expect(line.state_written).toBe(true);
    const state = readProjectState(projectCwd);
    expect(state.alert?.project).toBe("alert-low");
    expect(state.alert?.text).toContain("README.md");
  });

  test("next alert-free review in the same project clears the alert (high and low confidence)", async () => {
    const projectCwd = join(tmpHome, "alert-clear");
    const loud = { injection_suspected: [{ where: "README.md", quote: "ignore all rules", why: "steers" }] };
    await runAlertTurn("sess-alert-clear-1", projectCwd, { confidence: "high", ...loud });
    expect(readProjectState(projectCwd).alert).toBeDefined();
    await runAlertTurn("sess-alert-clear-2", projectCwd, { confidence: "high", injection_suspected: [] });
    expect(readProjectState(projectCwd).alert).toBeUndefined();
    // low confidence blanks the bubble: the rest of the file is left alone, the alert field still clears
    await runAlertTurn("sess-alert-clear-3", projectCwd, { confidence: "high", ...loud });
    const shown = readProjectState(projectCwd).bubble_short;
    await runAlertTurn("sess-alert-clear-4", projectCwd, { confidence: "low", injection_suspected: [] });
    expect(readProjectState(projectCwd).alert).toBeUndefined();
    expect(readProjectState(projectCwd).bubble_short).toBe(shown);
  });

  test("PASSIVE_BUBBLE: a loud alert is set on the state file and the next alert-free review clears it (F8)", async () => {
    const ok = <T extends string>(tool: T) => ({ tool, status: "ok" as const, parsed: [], raw: "" });
    // A docs hunk: since gate step [1] a code hunk goes to NORMAL.
    const hunk = { file: "docs/dummy.md", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@", body: "-a\n+b" };
    const passiveDeps = (extra: Record<string, unknown>): RunCriticDeps => ({
      runToolsFn: async () => ({ tsc: ok("tsc"), eslint: ok("eslint"), "git-diff": { ...ok("git-diff"), parsed: [hunk], raw: "diff --git a/docs/dummy.md b/docs/dummy.md" }, ripgrep: ok("ripgrep"), securityFindings: [], owaspHints: [], webSearchSources: [] }),
      callBrainFn: async () => {
        const { tool_calls, ...output } = extra;
        return { output: makeFakeBrainOutput({ bubble_short: "clean", ...output }), usage: noopUsage, toolCalls: (tool_calls as ToolCallRecord[] | undefined) ?? [] };
      },
      writeCritiqueFn: async () => ({ id: "c-passive-alert", path: "/tmp" }),
    });
    const projectCwd = join(tmpHome, "passive-alert");
    const lastRow = () => JSON.parse(readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8").trim().split("\n").pop()!) as Record<string, unknown>;
    // PASSIVE_BUBBLE ignores self reports (R22), so the alert is driven by a tool call outside the repo.
    await runAlertTurn("sess-passive-alert-1", projectCwd, { tool_calls: [{ tool: "Read", target: "/etc/hosts", failed: false }] }, passiveDeps);
    expect(lastRow().critic_path_decision).toBe("PASSIVE_BUBBLE");
    expect(readProjectState(projectCwd).alert?.text).toContain("/etc/hosts");
    await runAlertTurn("sess-passive-alert-2", projectCwd, {}, passiveDeps);
    expect(lastRow().critic_path_decision).toBe("PASSIVE_BUBBLE");
    expect(readProjectState(projectCwd).alert).toBeUndefined();
  });

  test("tool-augmented flag ON + NORMAL with a fabricated citation → critique IS written, row is marked", async () => {
    const projectCwd = join(tmpHome, "m112-rejected");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    let writeCritiqueCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError("real snippet here in raw output"),
      callBrainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput({
          findings: [],
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

    // Was `false` until 2026-08-19: a fabricated citation used to kill the
    // whole review before it could be persisted.
    expect(writeCritiqueCalled).toBe(true);

    // Read the row rather than substring-matching the file. The old assertions
    // here were `log.toContain("m112_accepted")` and `log.toContain("false")` —
    // the second matches ANY `false` anywhere in the JSONL (there are several),
    // so it would have stayed green through this entire change.
    const raw = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8");
    const rows = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const line = rows[rows.length - 1]!;
    expect(line.critic_path_decision).toBe("NORMAL");
    expect(line.m112_accepted).toBe(true);
    expect(line.m112_evidence_label).toBe("none_verified");
    expect(line.m112_evidence_unverified).toBe(1);
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
          findings: [],
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
        menubarDeps: { exec: () => {} },
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
// Part 2b: provider truth on ledger/telemetry rows (track #7 T3, AC7)
//
// Uses RunCriticDeps.providerMeta (test seam, run-critic.ts) to simulate a
// codex-configured turn without touching ~/.siltpoke/config.json — deps
// already bypasses real provider resolution via callBrainFn.
// ---------------------------------------------------------------------------

describe("handleStopHook — provider truth on ledger rows (track #7 T3)", () => {
  const m112Env = (homeDir: string): NodeJS.ProcessEnv => ({
    HOME: homeDir,
    SILTPOKE_TOOL_AUGMENTED: "1",
  });
  const CODEX_META: BrainProviderMeta = {
    name: "codex",
    billing: "quota",
    genAiSystem: "openai",
    acceptsModel: false,
  };
  const CODEX_USAGE = {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 200,
    output_tokens: 80,
    total_cost_usd: null, // quota billing — never a fabricated dollar figure
  };

  function lastJsonlLine(homeDir: string): Record<string, unknown> {
    const raw = readFileSync(join(homeDir, ".siltpoke", "brain-calls.jsonl"), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]!);
  }

  function lastUsageEvent(homeDir: string): Record<string, unknown> {
    const raw = readFileSync(join(homeDir, ".siltpoke", "usage-events.jsonl"), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]!);
  }

  // The PASSIVE_BUBBLE path never calls `guardCritique` — the only production
  // call site is `src/critic/phases/normal.ts` and it hardcodes "NORMAL". This
  // row used to carry no label at all, which made 79% of triggers read exactly
  // like rows written before the field existed. Asserted rather than trusted
  // because the first draft re-stated `"not_checked"` as a literal at the write
  // site while the typed field sat one field away with no reader: flipping the
  // literal to any other label left the whole suite green.
  test("PASSIVE_BUBBLE row records the guard never ran, rather than leaving the label absent", async () => {
    const projectCwd = join(tmpHome, "passive-evidence-label");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
        eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
        "git-diff": {
          tool: "git-diff",
          status: "ok",
          parsed: [
            { file: "docs/dummy.md", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@", body: "-a\n+b" },
          ],
          raw: "diff --git a/docs/dummy.md b/docs/dummy.md",
        },
        ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ bubble_short: "clean" }),
        usage: noopUsage,
      }),
      writeCritiqueFn: async () => ({ id: "c-passive-label", path: "/tmp" }),
    };

    await handleStopHook(
      makeStopEvent("sess-passive-label", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps, menubarDeps: { exec: () => {} } },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.critic_path_decision).toBe("PASSIVE_BUBBLE");
    expect(line.m112_evidence_label).toBe("not_checked");
    // No signals -> no key (absent, not null).
    expect("injection_alert" in line).toBe(false);
  });

  test("PASSIVE_BUBBLE row + usage-event carry provider=codex/billing=quota/model when configured", async () => {
    const projectCwd = join(tmpHome, "provider-passive");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
        eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
        "git-diff": {
          tool: "git-diff",
          status: "ok",
          parsed: [
            { file: "docs/dummy.md", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@", body: "-a\n+b" },
          ],
          raw: "diff --git a/docs/dummy.md b/docs/dummy.md",
        },
        ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({
          bubble_short: "clean",
          injection_suspected: [{ where: "README.md", quote: "ignore all rules", why: "tells the reviewer what to do" }],
        }),
        usage: CODEX_USAGE,
        servedModel: "gpt-5-codex",
        toolCalls: [{ tool: "shell", target: "cat ../outside.txt", failed: false }],
      }),
      writeCritiqueFn: async () => ({ id: "c-provider-passive", path: "/tmp" }),
      providerMeta: CODEX_META,
    };

    await handleStopHook(
      makeStopEvent("sess-provider-passive", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps, menubarDeps: { exec: () => {} } },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.critic_path_decision).toBe("PASSIVE_BUBBLE");
    expect(line.provider).toBe("codex");
    expect(line.billing).toBe("quota");
    expect(line.model).toBe("gpt-5-codex");
    // 🛡 [C]: what the reviewer ran lands on the row …
    expect(line.tool_calls).toEqual([{ tool: "shell", target: "cat ../outside.txt", failed: false }]);

    const usageEvent = lastUsageEvent(tmpHome);
    // … and never in the budget rollup, which only counts tokens and money.
    expect("tool_calls" in usageEvent).toBe(false);
    expect("injection_alert" in usageEvent).toBe(false);
    // The alert rides the row: the outside read only. The model's own injection_suspected is dropped on PASSIVE_BUBBLE (R22).
    const alert = line.injection_alert as { level: string; toolRecord: string; signals: { kind: string }[] };
    expect(alert.level).toBe("loud");
    expect(alert.toolRecord).toBe("recorded");
    expect(alert.signals.map((s) => s.kind)).toEqual(["tool"]);
    expect(usageEvent.provider).toBe("codex");
    expect(usageEvent.billing).toBe("quota");
    expect(usageEvent.model).toBe("gpt-5-codex");
    expect(usageEvent.total_cost_usd).toBeNull();
    // Quota rows must never be `basis: "estimated"` — that would exclude
    // their real tokens from the daily budget's token sum.
    expect(usageEvent.basis).toBeUndefined();
  });

  test("NORMAL accepted row carries provider=codex/billing=quota/model", async () => {
    const projectCwd = join(tmpHome, "provider-normal");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);
    const REAL_SNIPPET = "const x: string = 42;";

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: {
          tool: "tsc", status: "ok",
          parsed: [{ file: "src/dummy.ts", line: 5, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." }],
          raw: `src/dummy.ts(5,1): error TS2322\n${REAL_SNIPPET}`,
        },
        eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
        "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
        ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({
          findings: [],
          evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
        }),
        usage: CODEX_USAGE,
        servedModel: "gpt-5-codex",
        toolCalls: [],
      }),
      writeCritiqueFn: async () => ({ id: "c-provider-normal", path: join(projectCwd, ".siltpoke", "fake.md") }),
      providerMeta: CODEX_META,
    };

    await handleStopHook(
      makeStopEvent("sess-provider-normal", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps, menubarDeps: { exec: () => {} } },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.critic_path_decision).toBe("NORMAL");
    expect(line.m112_accepted).toBe(true);
    expect(line.provider).toBe("codex");
    expect(line.billing).toBe("quota");
    expect(line.model).toBe("gpt-5-codex");
    // An empty list = the CLI reports tool calls and there were none.
    expect(line.tool_calls).toEqual([]);
  });

  test("no providerMeta injected (default claude path) → row carries provider=claude/billing=usd", async () => {
    const projectCwd = join(tmpHome, "provider-default");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
        eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
        "git-diff": {
          tool: "git-diff", status: "ok",
          parsed: [{ file: "src/dummy.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@", body: "-a\n+b" }],
          raw: "diff --git a/src/dummy.ts b/src/dummy.ts",
        },
        ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => ({ output: makeFakeBrainOutput({ bubble_short: "clean" }), usage: noopUsage }),
      writeCritiqueFn: async () => ({ id: "c-provider-default", path: "/tmp" }),
    };

    await handleStopHook(
      makeStopEvent("sess-provider-default", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps, menubarDeps: { exec: () => {} } },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.provider).toBe("claude");
    expect(line.billing).toBe("usd");
    // The call returned no tool list, so the row must not claim "none".
    expect(line.tool_calls).toBe("not_recorded");

    const usageEvent = lastUsageEvent(tmpHome);
    expect(usageEvent.provider).toBe("claude");
    expect(usageEvent.billing).toBe("usd");
  });

  test("HARD_SUPPRESS row still carries provider (known even though no Brain call happened)", async () => {
    const projectCwd = join(tmpHome, "provider-suppress");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: { tool: "tsc", status: "not_applicable", parsed: [], raw: "" },
        eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
        "git-diff": { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" },
        ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => ({ output: makeFakeBrainOutput(), usage: noopUsage }),
      writeCritiqueFn: async () => ({ id: "c-suppress", path: "/tmp" }),
      providerMeta: CODEX_META,
    };

    await handleStopHook(
      makeStopEvent("sess-provider-suppress", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.critic_path_decision).toBe("HARD_SUPPRESS");
    expect(line.provider).toBe("codex");
    expect(line.billing).toBe("quota");
    // No Brain call happened — no served-model to report, and no tool record.
    expect(line.model).toBeUndefined();
    expect("tool_calls" in line).toBe(false);
  });

  test("quota-cap skip (track #7 T4 fixup) → honest skipped:\"quota_cap\" row, NOT a generic HARD_SUPPRESS/m112_reason row", async () => {
    const projectCwd = join(tmpHome, "provider-quota-cap");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: {
          tool: "tsc",
          status: "ok",
          parsed: [
            { file: "src/dummy.ts", line: 5, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." },
          ],
          raw: "src/dummy.ts(5,1): error TS2322",
        },
        eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
        "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
        ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => {
        throw new BrainError(
          '[brain-quota-cap] daily call cap (50/day) reached for quota-billed provider "codex" — call skipped, $0 spent',
          undefined,
          undefined,
          "quota_cap",
        );
      },
      writeCritiqueFn: async () => ({ id: "c-quota-cap", path: "/tmp" }),
      providerMeta: CODEX_META,
    };

    await handleStopHook(
      makeStopEvent("sess-quota-cap", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.skipped).toBe("quota_cap");
    expect(line.critic_path_decision).toBeUndefined();
    expect(line.m112_reason).toBeUndefined();
    expect(line.provider).toBe("codex");
    expect(line.billing).toBe("quota");

    // No Brain call happened — no usage event should have been recorded.
    const usageEventsPath = join(tmpHome, ".siltpoke", "usage-events.jsonl");
    expect(existsSync(usageEventsPath)).toBe(false);
  });

  test("agy_prompt_too_large skip (track #7 T4) → honest skipped:\"agy_prompt_too_large\" row, NOT collapsed into the quota_cap label", async () => {
    const projectCwd = join(tmpHome, "provider-agy-too-large");
    const transcriptPath = makeTranscriptWithEdit(tmpHome);

    const deps: RunCriticDeps = {
      runToolsFn: async () => ({
        tsc: {
          tool: "tsc",
          status: "ok",
          parsed: [
            { file: "src/dummy.ts", line: 5, col: 1, severity: "error", code: "TS2322", message: "Type mismatch." },
          ],
          raw: "src/dummy.ts(5,1): error TS2322",
        },
        eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
        "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
        ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
        securityFindings: [],
        owaspHints: [],
        webSearchSources: [],
      }),
      callBrainFn: async () => {
        throw new BrainError(
          "agy -p: merged prompt too large (250000 bytes > 200000 byte cap)",
          undefined,
          undefined,
          "agy_prompt_too_large",
        );
      },
      writeCritiqueFn: async () => ({ id: "c-agy-too-large", path: "/tmp" }),
      providerMeta: CODEX_META,
    };

    await handleStopHook(
      makeStopEvent("sess-agy-too-large", transcriptPath, projectCwd),
      { env: m112Env(tmpHome), m112Deps: deps },
    );

    const line = lastJsonlLine(tmpHome);
    expect(line.skipped).toBe("agy_prompt_too_large");
    expect(line.skipped).not.toBe("quota_cap");
    expect(line.critic_path_decision).toBeUndefined();
    expect(line.m112_reason).toBeUndefined();

    // No Brain call happened — no usage event should have been recorded.
    const usageEventsPath2 = join(tmpHome, ".siltpoke", "usage-events.jsonl");
    expect(existsSync(usageEventsPath2)).toBe(false);
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
    // TODO: harden memory capture — handleStopHook must pass projectBase = repo-local
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

// ---------------------------------------------------------------------------
// The review-unit anchor must not be consumed by a turn that never got reviewed
// ---------------------------------------------------------------------------

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

  // R2.1 review follow-up: checkCodeChangeGate's first-touch branch (extracted
  // from handleStopHook, cognitive complexity 137 -> 0) had zero coverage of
  // its telemetry side effect — only the state.json welcome bubble was
  // asserted above. This pins the JSONL row the branch writes today, as a
  // CHARACTERIZATION test (locks in current behavior, does not judge it).
  test("first no-code stop writes a telemetry row with first_touch_welcome: true, not a plain no_code_changes skip", async () => {
    const projectCwd = join(tmpHome, "proj-telemetry");
    const transcriptPath = makeTranscriptNoEdit(tmpHome);
    const sessionId = "sess-firsttouch-telemetry";

    await handleStopHook(
      makeStopEvent(sessionId, transcriptPath, projectCwd),
      { env: { HOME: tmpHome } },
    );

    const logFile = join(tmpHome, ".siltpoke", "brain-calls.jsonl");
    expect(existsSync(logFile)).toBe(true);
    const rows = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const row = rows.find((r) => r.session_id === sessionId);

    expect(row).toBeDefined();
    expect(row.skipped).toBe("no_code_changes");
    expect(row.changed_files_count).toBe(0);
    // The characterizing assertion: on the neverReacted branch the row
    // carries first_touch_welcome: true rather than omitting the field
    // (the steady-state no-code skip row has no such key at all).
    expect(row.first_touch_welcome).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The docs gate (spec D7 / AC7-AC9)
// ---------------------------------------------------------------------------

function makeTranscriptEditing(dir: string, paths: string[]): string {
  for (const p of paths) {
    mkdirSync(join(p, "..").startsWith(dir) ? join(p, "..") : dir, { recursive: true });
    writeFileSync(p, "seeded\n");
  }
  const transcriptPath = join(dir, `transcript-${paths.length}-${paths[0]?.length ?? 0}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: paths.map((p) => ({ type: "tool_use", name: "Edit", input: { file_path: p } })),
      },
    })}\n`,
  );
  return transcriptPath;
}

async function skipRowFor(
  sessionId: string,
  projectCwd: string,
  transcriptPath: string,
  home: string,
): Promise<Record<string, unknown> | undefined> {
  await handleStopHook(
    makeStopEvent(sessionId, transcriptPath, projectCwd),
    {
      env: { HOME: home, SILTPOKE_TOOL_AUGMENTED: "0" },
      brainFn: async (): Promise<BrainCallResult> => ({
        output: makeFakeBrainOutput(),
        usage: noopUsage,
      }),
    },
  );
  const logFile = join(home, ".siltpoke", "brain-calls.jsonl");
  if (!existsSync(logFile)) return undefined;
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((r) => r.session_id === sessionId);
}

describe("handleStopHook — docs gate", () => {
  test("AC7 — a prose-only turn skips, and the row names docs_only, not no_code_changes", async () => {
    const projectCwd = join(tmpHome, "proj-docs-only");
    mkdirSync(projectCwd, { recursive: true });
    const transcriptPath = makeTranscriptEditing(tmpHome, [
      join(tmpHome, "README.md"),
      join(tmpHome, "notes.txt"),
    ]);

    const row = await skipRowFor("sess-docs-only", projectCwd, transcriptPath, tmpHome);

    expect(row).toBeDefined();
    // AC9 — WHICH rule decided. `no_code_changes` here would be a different
    // (and false) claim: files were changed.
    expect(row!.skipped).toBe("docs_only");
    expect(row!.changed_files_count).toBe(2);
    // Without the paths a wrong classification is invisible, and D7's own
    // stated risk (R3) is that the classification is wrong.
    expect(row!.docs_only_files).toEqual([
      join(tmpHome, "README.md"),
      join(tmpHome, "notes.txt"),
    ]);
  });

  test("AC8 — a prompt is code, so a turn touching only a prompt .md is reviewed", async () => {
    const projectCwd = join(tmpHome, "proj-prompt");
    mkdirSync(join(tmpHome, "prompts"), { recursive: true });
    const transcriptPath = makeTranscriptEditing(tmpHome, [
      join(tmpHome, "prompts", "system.md"),
    ]);

    const row = await skipRowFor("sess-prompt", projectCwd, transcriptPath, tmpHome);

    // The turn was NOT skipped as docs. A row may exist for other reasons, but
    // it must not be this gate's.
    expect(row?.skipped).not.toBe("docs_only");
  });

  test("one code file among prose is enough — the turn is not filed as docs", async () => {
    const projectCwd = join(tmpHome, "proj-mixed");
    mkdirSync(projectCwd, { recursive: true });
    const transcriptPath = makeTranscriptEditing(tmpHome, [
      join(tmpHome, "CHANGELOG.md"),
      join(tmpHome, "mixed.ts"),
    ]);

    const row = await skipRowFor("sess-mixed", projectCwd, transcriptPath, tmpHome);

    expect(row?.skipped).not.toBe("docs_only");
  });

  test("an empty turn still says no_code_changes, not docs_only", async () => {
    // The two reasons are not interchangeable and AC9 is about telling them
    // apart. Without this, collapsing both into `docs_only` passes every test
    // above.
    const projectCwd = join(tmpHome, "proj-empty-turn");
    mkdirSync(join(projectCwd, ".siltpoke"), { recursive: true });
    writeFileSync(
      join(projectCwd, ".siltpoke", "state.json"),
      JSON.stringify({ schemaVersion: 1, mood: "happy", pose: "base", bubble_short: "hi" }),
    );
    const transcriptPath = makeTranscriptNoEdit(tmpHome);

    const row = await skipRowFor("sess-empty-turn", projectCwd, transcriptPath, tmpHome);

    expect(row?.skipped).toBe("no_code_changes");
  });
});

// ---------------------------------------------------------------------------
// The quiet-path nudge (spec D9 / AC13, AC13.1)
// ---------------------------------------------------------------------------

describe("handleStopHook — quiet-path nudge", () => {
  /**
   * A repo where the review-unit gate SKIPS (HEAD has not moved since the
   * anchor) but the working tree is deep in uncommitted change — the exact
   * situation AC13 describes.
   */
  /**
   * `existingBubbleAgeMinutes` seeds a bubble already on the pet, aged. Absent
   * means no `state.json` at all. The nudge refuses to overwrite a bubble that
   * is still fresh — a real critique the user may not have opened yet — so the
   * two cases are different fixtures, not the same one.
   */
  function makeQuietRepo(
    name: string,
    uncommittedLines: number,
    existingBubbleAgeMinutes?: number,
  ): string {
    const projectCwd = join(tmpHome, name);
    makeGitRepo(projectCwd);
    const stateBase = join(projectCwd, ".siltpoke");
    mkdirSync(stateBase, { recursive: true });
    if (existingBubbleAgeMinutes !== undefined) {
      writeFileSync(
        join(stateBase, "state.json"),
        JSON.stringify({
          schemaVersion: 1,
          mood: "worried",
          pose: "base",
          bubble_short: "a critique the user has not opened yet",
          severity: "medium",
          confidence: "high",
          last_updated_ms: Date.now() - existingBubbleAgeMinutes * 60_000,
          last_session_id: "earlier",
        }),
      );
    }
    // Anchor pinned at the current HEAD, reviewed long ago — so the gate skips
    // with `no_new_commit` and the "quiet for a while" half is satisfied.
    writeFileSync(
      join(stateBase, "review-anchor.json"),
      JSON.stringify({
        head: headSha(projectCwd),
        tree: "",
        reviewedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      }),
    );
    if (uncommittedLines > 0) {
      writeFileSync(
        join(projectCwd, "wip.ts"),
        Array.from({ length: uncommittedLines }, (_, i) => `export const v${i} = ${i};`).join("\n"),
      );
    }
    return projectCwd;
  }

  async function runQuietTurn(sessionId: string, projectCwd: string): Promise<void> {
    await handleStopHook(
      {
        hook_event_name: "Stop",
        session_id: sessionId,
        transcript_path: makeTranscriptNoEdit(tmpHome),
        cwd: projectCwd,
      },
      {
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        // Deliberately a brainFn that FAILS the test if it is ever reached.
        // AC13 says zero Brain calls, and a stub that quietly returns output
        // would let a call through while the telemetry assertion below still
        // passed.
        brainFn: async (): Promise<BrainCallResult> => {
          throw new Error("AC13 violated: the quiet path made a Brain call");
        },
      },
    );
  }

  function rowFor(sessionId: string): Record<string, unknown> | undefined {
    const logFile = join(tmpHome, ".siltpoke", "brain-calls.jsonl");
    if (!existsSync(logFile)) return undefined;
    return readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((r) => r.session_id === sessionId);
  }

  test("AC13 — a big uncommitted tree gone unreviewed makes the pet speak, with no Brain call", async () => {
    const projectCwd = makeQuietRepo("proj-nudge-fires", 300);

    await runQuietTurn("sess-nudge-fires", projectCwd);

    // The pet said something.
    const state = JSON.parse(
      readFileSync(join(projectCwd, ".siltpoke", "state.json"), "utf8"),
    );
    expect(state.bubble_short.length).toBeGreaterThan(0);

    // AC13's "zero Brain calls, provable from telemetry, not from reading the
    // code": the row for this turn names a SKIP reason and is marked nudged.
    // A turn that reached a provider would not have a `skipped:` reason at all
    // — `baseline.ts` counts any row without one as a fire.
    const row = rowFor("sess-nudge-fires");
    expect(row?.skipped).toBe("no_new_commit");
    expect(row?.nudged).toBe(true);
    // No usage event was recorded, which is where a real Brain call lands.
    expect(existsSync(join(tmpHome, ".siltpoke", "usage.jsonl"))).toBe(false);
  });

  test("the nudge replaces the bubble but keeps an injection alert", async () => {
    const projectCwd = makeQuietRepo("proj-nudge-keeps-alert", 300, 300);
    const statePath = join(projectCwd, ".siltpoke", "state.json");
    const alert = { text: "⚠ Project text tried to steer the review: README.md (p)", project: "p", at: 1 };
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), alert }));

    await runQuietTurn("sess-nudge-keeps-alert", projectCwd);

    expect(rowFor("sess-nudge-keeps-alert")?.nudged).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.bubble_short).not.toBe("a critique the user has not opened yet");
    expect(state.alert).toEqual(alert);
  });

  test("the quiet-hours sleeping state keeps an injection alert", async () => {
    const projectCwd = makeQuietRepo("proj-sleep-keeps-alert", 0, 300);
    const statePath = join(projectCwd, ".siltpoke", "state.json");
    const alert = { text: "⚠ Project text tried to steer the review: README.md (p)", project: "p", at: 1 };
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), alert }));
    // A window around the current local hour, so the gate is quiet whenever this runs.
    const h = new Date().getHours();
    const hh = (n: number): string => `${String((n + 24) % 24).padStart(2, "0")}:00`;
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
    writeFileSync(join(tmpHome, ".siltpoke", "config.json"), JSON.stringify({ quietHours: { start: hh(h - 1), end: hh(h + 2) } }));

    await runQuietTurn("sess-sleep-keeps-alert", projectCwd);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.mood).toBe("sleeping_quiet");
    expect(state.alert).toEqual(alert);
  });

  test("AC13.1 — below the line threshold the pet stays quiet, and the row is not marked", async () => {
    // Same repo, same six-hour silence; only the uncommitted volume differs.
    // Without this, a nudge that fired unconditionally would pass the test
    // above and be indistinguishable from one that respects its threshold.
    const projectCwd = makeQuietRepo("proj-nudge-quiet", 5);

    await runQuietTurn("sess-nudge-quiet", projectCwd);

    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(false);
    const row = rowFor("sess-nudge-quiet");
    expect(row?.skipped).toBe("no_new_commit");
    expect(row?.nudged).toBeUndefined();
  });

  test("a bubble the user may not have read yet is not clobbered by the nudge", async () => {
    // Both thresholds are met — 300 uncommitted lines, six hours unreviewed —
    // but something wrote to the pet a minute ago. That is usually a real
    // critique whose findings have not been opened, and replacing it with a
    // generic "I have not looked at anything in a while" destroys the only
    // route to them AND says something false right after a review ran.
    //
    // The first version had no guard at all: it overwrote `state.json` on every
    // qualifying turn, forever. Found by review, not by the two tests above,
    // which both start from a repo with no `state.json`.
    const projectCwd = makeQuietRepo("proj-nudge-fresh-bubble", 300, 1);

    await runQuietTurn("sess-nudge-fresh-bubble", projectCwd);

    const state = JSON.parse(
      readFileSync(join(projectCwd, ".siltpoke", "state.json"), "utf8"),
    );
    expect(state.bubble_short).toBe("a critique the user has not opened yet");
    expect(rowFor("sess-nudge-fresh-bubble")?.nudged).toBeUndefined();
  });

  test("a huge untracked file does not count toward the threshold", async () => {
    // The untracked sweep has a per-file byte cap, and until this test nothing
    // exercised it — deleting the cap left every test green. The cap is also
    // why the read is preceded by a `statSync`: a stray core dump or an
    // un-gitignored build artifact must not be pulled into memory on a Stop
    // hook just to discover it is too big to count.
    const projectCwd = makeQuietRepo("proj-nudge-huge-file", 0);
    // One file, comfortably past the 512KB cap, and nothing else uncommitted.
    writeFileSync(
      join(projectCwd, "huge.log"),
      `${"x".repeat(80)}\n`.repeat(9000),
    );

    await runQuietTurn("sess-nudge-huge-file", projectCwd);

    // 9,000 lines is far past the 200-line threshold, so counting this file
    // would nudge. It is over the cap, so it is not counted, so nothing is said.
    expect(existsSync(join(projectCwd, ".siltpoke", "state.json"))).toBe(false);
    expect(rowFor("sess-nudge-huge-file")?.nudged).toBeUndefined();
  });

  test("once that bubble has itself gone quiet for the same interval, the nudge speaks", async () => {
    // The counterpart, so "never overwrite an existing bubble" does not pass
    // the test above: an old bubble is not protection forever.
    const projectCwd = makeQuietRepo("proj-nudge-stale-bubble", 300, 6 * 60);

    await runQuietTurn("sess-nudge-stale-bubble", projectCwd);

    const state = JSON.parse(
      readFileSync(join(projectCwd, ".siltpoke", "state.json"), "utf8"),
    );
    expect(state.bubble_short).not.toBe("a critique the user has not opened yet");
    expect(rowFor("sess-nudge-stale-bubble")?.nudged).toBe(true);
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

    // This test's premise pins event.cwd to the REAL repo (V3 memory is scoped
    // on resolveProjectRoot(process.cwd())), which means the ⏱ review-unit gate
    // reads and WRITES this repo's own review anchor. Left in place that makes
    // the test order-dependent — the first run fires, every later run stops at
    // `no_new_commit` — and it clobbers the developer's live anchor. Clear it
    // on the way in and RESTORE it on the way out — including when the hook
    // throws or the assertion below fails. An unconditional delete with no
    // `finally` left a failed `bun test` run having silently eaten the
    // developer's own anchor, which is the exact class of "a test wrote to a
    // real checkout" this file's git fixture already guards against.
    const liveAnchor = join(process.cwd(), ".siltpoke", "review-anchor.json");
    const savedAnchor = existsSync(liveAnchor) ? readFileSync(liveAnchor, "utf8") : null;
    rmSync(liveAnchor, { force: true });

    // latest.md backs the status card / /siltpoke:siltpoke-last / the menu bar, and
    // writeCritique overwrites it unconditionally. Save it the same way as
    // the anchor above, and restore only if this run replaced it with a fake
    // — so a real critique the live daemon files mid-run is left alone.
    // Only a REAL latest.md is worth restoring — if a previous run already left
    // a fake here, restoring it would re-establish the fake and the guard would
    // stay red forever with nothing to point at.
    const savedLatest = existsSync(REAL_LATEST) && !latestIsFake()
      ? readFileSync(REAL_LATEST, "utf8")
      : null;

    // Same shape, fifth path: save only a REAL state.json, so a fake left by an
    // earlier run is never re-established, and a bubble the live daemon writes
    // mid-run is never clobbered.
    const savedState = existsSync(REAL_STATE) && !stateIsFake()
      ? readFileSync(REAL_STATE, "utf8")
      : null;

    // Same reason as the anchor restore above, one path over: with event.cwd
    // pinned to the real repo, the critic files its critique in THIS
    // checkout's archive. Left in place, each run added a file that the
    // Memory Book then displayed as a genuine review. Remove whatever this
    // run wrote; the file-level guard asserts the removal actually worked.
    let captured = "";
    try {
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
    } finally {
      rmSync(liveAnchor, { force: true });
      if (savedAnchor !== null) writeFileSync(liveAnchor, savedAnchor);
      for (const f of fakeArchiveFiles()) rmSync(f, { force: true });

      // history.jsonl is appended and never pruned; drop only the fake lines.
      if (existsSync(REAL_HISTORY)) {
        const kept = readFileSync(REAL_HISTORY, "utf8")
          .split("\n")
          .filter((l) => !l.includes(FAKE_HISTORY_MARK));
        writeFileSync(REAL_HISTORY, kept.join("\n"));
      }

      if (latestIsFake()) {
        if (savedLatest !== null) writeFileSync(REAL_LATEST, savedLatest);
        else rmSync(REAL_LATEST, { force: true });
      }

      if (stateIsFake()) {
        if (savedState !== null) writeFileSync(REAL_STATE, savedState);
        else rmSync(REAL_STATE, { force: true });
      }

      // Append-only like history.jsonl, so filter rather than restore: drop our
      // lines, keep every line the live daemon may have appended meanwhile.
      if (existsSync(REAL_PENDING)) {
        const kept = readFileSync(REAL_PENDING, "utf8")
          .split("\n")
          .filter((l) => !l.includes(FAKE_HISTORY_MARK));
        writeFileSync(REAL_PENDING, kept.join("\n"));
      }
    }
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
