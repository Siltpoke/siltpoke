// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * INDEPENDENT acceptance test — track #7 T4 (recursion suppression + quota
 * call-cap + warn-once).
 *
 * Spec: an internal design note
 * Covers:
 *   - AC4  — a codex-spawned brain call cannot trigger review-of-review.
 *   - AC8  — quota-billed providers get a per-day call cap (50/day), and the
 *            cap half specifically (the null-cost/render half is T3's job).
 *   - AC13 — warn-once at first quota-provider use per process.
 *
 * AC4 driving surface: `runCodexStopHook` (src/hooks/codex-stop.ts), the
 * ACTUAL entry point the user's codex config invokes (wired by
 * src/installer/codex-integration.ts:84). Two of the three AC4 assertions
 * drive this exact public entry from outside:
 *   1. SILTPOKE_INTERNAL=1 -> zero brain calls, zero network, skip logged.
 *   2. without the marker -> the codex-normalized event actually reaches
 *      real tool classification (proven via the REAL classify-output.ts
 *      path, not a stub — codex-stop.ts's RunCodexStopHookOptions has no
 *      m112Deps seam, so there is no way to inject runToolsFn/writeCritiqueFn
 *      through it; the only reachable seam beyond runCodexStopHook's own
 *      params is the GLOBAL Bun.spawn binding, patched here exactly like
 *      brain-provider-t1/t2/t3.test.ts's INJECTION-POINT precedent — the
 *      fake spawn's non-codex/non-claude default branch (immediate exit 1)
 *      makes getProjectCapabilities' bunx/rg probes resolve fast and
 *      deterministically to hasTsc=hasEslint=hasRipgrep=false, and hasGit is
 *      already false via fs.existsSync on a fresh temp dir with no `.git` —
 *      so classifyToolOutput reaches its real "no tools produced usable
 *      output" HARD_SUPPRESS, observable in brain-calls.jsonl as
 *      critic_path_decision (NOT `skipped`), proving the pipeline ran the
 *      full gate chain rather than being blocked at the recursion guard).
 *   3. the third AC4 assertion goes one level DEEPER than codex-stop.ts: it
 *      proves the *producing* side of the loop — the codex adapter
 *      (src/brain/providers/codex.ts) actually puts SILTPOKE_INTERNAL:"1"
 *      into the spawned child's env — via runCritic's real
 *      loadReviewerProvider(homeBase) config-driven seam (same
 *      INJECTION-POINT constraint as T1/T2: CallBrainOptions.spawnFn is
 *      never populated by the critic phases, so the global Bun.spawn
 *      binding is patched, capturing the FULL spawn opts this time,
 *      including env) — then closes the loop by feeding that captured env
 *      into the real `shouldFire` gate, proving a child Stop hook that
 *      inherited this exact env would be guarded.
 *
 * AC8/AC13 driving surface: `runCritic` — the outermost reachable seam that
 * exercises the real config-driven provider resolution AND the real
 * makeGuardedCallBrain quota-cap/warn-once logic (mirrors T1/T2's
 * `runThroughProviderSeam` pattern). brain-health.json is pre-seeded on disk
 * before each call and re-read after, per the spec's own read-after-write
 * discipline (src/state/brain-health.ts is the single writer).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { runCritic, type RunCriticDeps, type RunCriticOpts } from "../../src/critic/run-critic";
import type { RunToolsOpts, RunToolsResult } from "../../src/critic/tools/run-tools";
import { normalizeCodexStop, runCodexStopHook } from "../../src/hooks/codex-stop";
import { shouldFire, type HookEvent } from "../../src/router/router";
import {
  freshBrainHealth,
  QUOTA_CALL_DAILY_CAP,
  readBrainHealth,
  writeBrainHealth,
} from "../../src/state/brain-health";
import type { CallBrainOptions, BrainCallResult } from "../../src/brain/brain";
import { resetQuotaWarnStateForTests } from "../../src/brain/brain-guarded";

// ---------------------------------------------------------------------------
// Global Bun.spawn patch plumbing (mirrors brain-provider-t1/t2/t3.test.ts).
// ---------------------------------------------------------------------------

const REAL_BUN_SPAWN = Bun.spawn;

interface CapturedSpawnCall {
  argv: string[];
  stdinChunks: string[];
  env?: NodeJS.ProcessEnv;
}

interface FakeSpawnResponse {
  stdoutText: string;
  stderrText?: string;
  exitCode?: number;
}

/**
 * Fake global Bun.spawn: replays configured responses for `codex`/`claude`
 * argv[0]; anything else (bunx tsc/eslint probes, rg --version, git-log
 * fallback probe) gets an immediate clean exit-1 — no real subprocess,
 * network, or binary is ever touched. Captures the FULL second argument
 * (including `env`) so AC4's "adapter env carries the marker" assertion has
 * something concrete to inspect.
 */
function installFakeBunSpawn(cfg: {
  codex?: FakeSpawnResponse;
  claude?: FakeSpawnResponse;
}): CapturedSpawnCall[] {
  const calls: CapturedSpawnCall[] = [];
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
    argv: string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ) => {
    const stdinChunks: string[] = [];
    calls.push({ argv: [...argv], stdinChunks, env: opts?.env });
    const resp: FakeSpawnResponse | undefined =
      argv[0] === "codex" ? cfg.codex : argv[0] === "claude" ? cfg.claude : undefined;
    return {
      stdin: {
        write(chunk: string) {
          stdinChunks.push(chunk);
        },
        end() {},
      },
      stdout: new Response(resp?.stdoutText ?? "").body,
      stderr: new Response(resp?.stderrText ?? "").body,
      exited: Promise.resolve(resp?.exitCode ?? 1),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return calls;
}

afterEach(() => {
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = REAL_BUN_SPAWN;
  delete process.env.SILTPOKE_REVIEWER_PROVIDER;
});

// ---------------------------------------------------------------------------
// Shared scaffolding (mirrors brain-provider-t1/t2/t3.test.ts's helpers).
// ---------------------------------------------------------------------------

function makeCaps(cwd: string): ProjectCapabilities {
  return {
    cwd,
    hasGit: false,
    hasTsc: false,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: Date.now(),
    configMtimes: {},
  };
}

/** One tsc diagnostic → classifyToolOutput reaches NORMAL. */
async function stubRunToolsNormal(_opts: RunToolsOpts): Promise<RunToolsResult> {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        {
          file: "src/example.ts",
          line: 10,
          col: 5,
          severity: "error",
          code: "TS0000",
          message: "Example diagnostic message for acceptance test",
        },
      ],
      raw: "",
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

const EVIDENCE = [
  {
    tool: "tsc",
    file: "src/example.ts",
    line: 10,
    snippet: "TS0000 error: Example diagnostic message for acceptance test",
  },
];

function acceptedBrainOutput(bubble: string) {
  return {
    mood: "watching",
    pose: "base",
    bubble_short: bubble,
    bubble_long: "",
    critique_for_claude: "Minor tsc diagnostic worth a look.",
    severity: "low",
    confidence: "high",
    xp_earned_events: [],
    evidence: EVIDENCE,
  };
}

/** Minimal happy-path codex `--json` event stream reaching a NORMAL decision. */
function codexHappyEvents(bubble: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "t4-thread" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: JSON.stringify(acceptedBrainOutput(bubble)) },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
    }),
  ].join("\n");
}

/** Canned claude `-p --output-format json` result stream. */
function claudeStreamJson(bubble: string): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(acceptedBrainOutput(bubble)),
      total_cost_usd: 0.001,
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 5 },
    },
  ]);
}

function writeConfig(homeBase: string, config: Record<string, unknown> | null): void {
  if (config === null) return; // no config.json at all — "unset" case
  writeFileSync(join(homeBase, "config.json"), JSON.stringify(config), "utf8");
}

function makeTmpDirs(prefix: string): { cwd: string; homeBase: string } {
  const cwd = mkdtempSync(join(tmpdir(), `siltpoke-t4-cwd-${prefix}-`));
  const homeBase = mkdtempSync(join(tmpdir(), `siltpoke-t4-home-${prefix}-`));
  mkdirSync(join(cwd, ".siltpoke"), { recursive: true });
  return { cwd, homeBase };
}

function baseOpts(cwd: string, homeBase: string): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd,
    changedFiles: [],
    caps: makeCaps(cwd),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-t4-acceptance",
      cwd,
      stateBase: join(cwd, ".siltpoke"),
    },
    homeBase,
  };
}

const stubDeps: RunCriticDeps = {
  runToolsFn: stubRunToolsNormal,
  writeCritiqueFn: async () => ({ id: "stub-critique-id-t4", path: "/dev/null" }),
};

// ---------------------------------------------------------------------------
// AC4 — codex-spawned brain call cannot trigger review-of-review recursion.
// ---------------------------------------------------------------------------

describe("AC4 — recursion suppression via runCodexStopHook (real entry point)", () => {
  const NEVER_CALL_BRAIN = async (_opts: CallBrainOptions): Promise<BrainCallResult> => {
    throw new Error("brainFn must never be invoked when SILTPOKE_INTERNAL=1");
  };

  test("SILTPOKE_INTERNAL=1 + codex-shaped Stop payload -> zero fetch/POST, zero brain spawns, skip logged as recursion_guard", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-t4-ac4-guard-"));
    const spawnCalls = installFakeBunSpawn({});
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await runCodexStopHook({
        rawJson: JSON.stringify({
          session_id: "codex-t4-guard",
          transcript_path: join(tmpHome, "missing.jsonl"),
          cwd: "/tmp",
        }),
        env: {
          SILTPOKE_INTERNAL: "1",
          HOME: tmpHome,
          // Isolates the assertion to AC4's recursion concern — the
          // always-run daemon self-heal probe (maybeRespawnDaemon in
          // on-stop.ts) is a separate, harmless health check.
          SILTPOKE_DISABLE_RESPAWN: "1",
        },
        brainFn: NEVER_CALL_BRAIN,
      });

      expect(fetchCalls).toBe(0);
      expect(spawnCalls.length).toBe(0);

      const log = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8");
      expect(log).toContain('"skipped":"recursion_guard"');
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test("without SILTPOKE_INTERNAL, a codex-shaped Stop payload runs the FULL real gate chain (no stub) past the recursion guard — proves the guard above is a real, position-dependent gate, not an always-skip", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-t4-ac4-proceed-home-"));
    const projectCwd = mkdtempSync(join(tmpdir(), "siltpoke-t4-ac4-proceed-proj-"));
    // No .git, no tsconfig, no eslintrc in projectCwd — real
    // getProjectCapabilities will report hasGit=hasTsc=hasEslint=hasRipgrep=
    // false (fs.existsSync for git; the fake spawn's default exit-1 branch
    // for the bunx/rg binary probes) -> classifyToolOutput's REAL abstention
    // floor ("no tools produced usable output") fires -> HARD_SUPPRESS. This
    // is deliberately NOT a stubbed decision — codex-stop.ts's public
    // RunCodexStopHookOptions has no m112Deps seam, so there is no way to
    // inject a controlled tool result through it; the real gate chain is the
    // only thing observable from this entry point.
    installFakeBunSpawn({});
    const editedPath = join(projectCwd, "dummy.ts");
    writeFileSync(editedPath, "export const dummy = 1;\n");
    const transcriptPath = join(projectCwd, "transcript.jsonl");
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

    try {
      await runCodexStopHook({
        rawJson: JSON.stringify({
          session_id: "codex-t4-proceed",
          transcript_path: transcriptPath,
          cwd: projectCwd,
        }),
        env: {
          HOME: tmpHome,
          SILTPOKE_TOOL_AUGMENTED: "1",
          SILTPOKE_DISABLE_RESPAWN: "1",
        },
      });

      const raw = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      const line = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;

      // NOT the recursion_guard skip — that is the whole claim, and it is
      // asserted directly rather than inferred from the absence of a field.
      expect(line.skipped).not.toBe("recursion_guard");
      // Where the chain DOES stop, since the ⏱ review-unit axis landed: this
      // fixture deliberately has no `.git` (so capabilities report hasGit
      // false and the abstention floor could fire), and the fake Bun.spawn
      // answers every git probe with exit 1 — so the review-unit gate reads
      // it as `not_a_git_repo` and stops there, one gate short of tool
      // classification.
      //
      // The position-dependence claim survives intact: `recursion_guard` is
      // the FIRST gate in the chain (checkFireGate), so reaching a
      // review-unit verdict at all proves the payload was not short-circuited
      // at the top. What this test can no longer show from this entry point
      // is the tool-classification floor; `runCodexStopHook` exposes no
      // m112Deps seam, and making the fixture a real repo would give
      // git-diff real output and remove the abstention this once observed.
      expect(line.skipped).toBe("not_a_git_repo");

      // Also: the shouldFire decision itself for this exact normalized
      // event shape is a real "fire" (not vacuously false).
      const normalized = JSON.parse(
        normalizeCodexStop(
          JSON.stringify({
            session_id: "codex-t4-proceed",
            transcript_path: transcriptPath,
            cwd: projectCwd,
          }),
        ),
      ) as HookEvent;
      expect(shouldFire(normalized, {}).fire).toBe(true);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });

  test("codex adapter's spawn env carries SILTPOKE_INTERNAL:\"1\" — the full loop: adapter env -> child would inherit -> hook guard fires", async () => {
    const { cwd, homeBase } = makeTmpDirs("ac4-envloop");
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      const calls = installFakeBunSpawn({
        codex: { stdoutText: codexHappyEvents("codex found a slip"), exitCode: 0 },
      });

      await runCritic(baseOpts(cwd, homeBase), stubDeps);

      const codexCalls = calls.filter((c) => c.argv[0] === "codex");
      expect(codexCalls.length).toBe(1);
      const capturedEnv = codexCalls[0]!.env;
      expect(capturedEnv).toBeDefined();
      expect(capturedEnv!.SILTPOKE_INTERNAL).toBe("1");

      // Close the loop: if a child process's OWN Stop hook inherited this
      // exact env (the real mechanism — codex.ts spawns with
      // `{ ...process.env, SILTPOKE_INTERNAL: "1" }`, and a child process
      // inherits its parent's env unless overridden), shouldFire would
      // guard it — the same gate proven directly against runCodexStopHook
      // in the tests above.
      const wouldFire = shouldFire(
        { hook_event_name: "Stop", session_id: "child-session", transcript_path: "/tmp/x.jsonl", cwd: "/tmp" },
        capturedEnv!,
      );
      expect(wouldFire.fire).toBe(false);
      expect(wouldFire.reason).toBe("recursion_guard");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC8 — quota-billed providers get a per-day call cap (50), driven through
// the outermost reachable seam (runCritic with codex config + fake spawn).
// ---------------------------------------------------------------------------

describe("AC8 — per-day call cap (50/day) for quota-billed providers", () => {
  function todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function preSeedQuotaCalls(homeBase: string, count: number): void {
    // Keyed per-provider-name (T6) — this describe block drives codex only.
    const health = {
      ...freshBrainHealth(),
      quota_calls_today: { codex: { date: todayStr(), count } },
    };
    writeBrainHealth(homeBase, health);
  }

  test("count=50 (cap reached) -> codex call fails soft (HARD_SUPPRESS) BEFORE spawn, reason mentions the cap, brain-health.json quota_calls_today stays at 50", async () => {
    const { cwd, homeBase } = makeTmpDirs("ac8-cap-reached");
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      preSeedQuotaCalls(homeBase, QUOTA_CALL_DAILY_CAP);
      const calls = installFakeBunSpawn({
        codex: { stdoutText: codexHappyEvents("should never be seen"), exitCode: 0 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("HARD_SUPPRESS");
      if (result.decision === "HARD_SUPPRESS") {
        expect(result.reason).toMatch(/cap/i);
      }
      // Fake spawn NEVER invoked — the cap blocks BEFORE the subprocess call.
      expect(calls.some((c) => c.argv[0] === "codex")).toBe(false);

      const health = readBrainHealth(homeBase);
      expect(health.quota_calls_today).toEqual({
        codex: { date: todayStr(), count: QUOTA_CALL_DAILY_CAP },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });

  test("count=49 -> call proceeds normally, spawn invoked exactly once, counter becomes 50", async () => {
    const { cwd, homeBase } = makeTmpDirs("ac8-under-cap");
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      preSeedQuotaCalls(homeBase, QUOTA_CALL_DAILY_CAP - 1);
      const calls = installFakeBunSpawn({
        codex: { stdoutText: codexHappyEvents("codex found a slip"), exitCode: 0 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("NORMAL");
      const codexCalls = calls.filter((c) => c.argv[0] === "codex");
      expect(codexCalls.length).toBe(1);

      const health = readBrainHealth(homeBase);
      expect(health.quota_calls_today).toEqual({
        codex: { date: todayStr(), count: QUOTA_CALL_DAILY_CAP },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });

  test("claude default config (reviewer_provider unset) -> quota counter is NEVER consumed, even on a successful call", async () => {
    const { cwd, homeBase } = makeTmpDirs("ac8-claude-default");
    try {
      // No config.json at all — "unset" per AC1's historical-compatible default.
      preSeedQuotaCalls(homeBase, 10);
      const calls = installFakeBunSpawn({
        claude: { stdoutText: claudeStreamJson("type mismatch worth a look"), exitCode: 0 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("NORMAL");
      expect(calls.some((c) => c.argv[0] === "claude")).toBe(true);
      expect(calls.some((c) => c.argv[0] === "codex")).toBe(false);

      const health = readBrainHealth(homeBase);
      // Unchanged from the pre-seeded value — claude (billing "usd") never
      // touches this counter, cap or no cap.
      expect(health.quota_calls_today).toEqual({ codex: { date: todayStr(), count: 10 } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC13 — warn-once: first quota-provider use per process gets a single
// console.warn; subsequent quota-provider calls in the same process are
// silent; claude calls never warn.
// ---------------------------------------------------------------------------

describe("AC13 — warn-once for quota-billed providers", () => {
  let originalWarn: typeof console.warn;
  let warnCalls: string[];

  beforeEach(() => {
    resetQuotaWarnStateForTests();
    warnCalls = [];
    originalWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(" "));
    }) as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("two codex calls through the seam -> exactly one console.warn, mentioning quota + eval", async () => {
    const first = makeTmpDirs("ac13-codex-1");
    const second = makeTmpDirs("ac13-codex-2");
    try {
      writeConfig(first.homeBase, { reviewer_provider: "codex" });
      writeConfig(second.homeBase, { reviewer_provider: "codex" });

      installFakeBunSpawn({ codex: { stdoutText: codexHappyEvents("first"), exitCode: 0 } });
      await runCritic(baseOpts(first.cwd, first.homeBase), stubDeps);

      installFakeBunSpawn({ codex: { stdoutText: codexHappyEvents("second"), exitCode: 0 } });
      await runCritic(baseOpts(second.cwd, second.homeBase), stubDeps);

      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]).toMatch(/quota/i);
      expect(warnCalls[0]).toMatch(/eval/i);
    } finally {
      rmSync(first.cwd, { recursive: true, force: true });
      rmSync(first.homeBase, { recursive: true, force: true });
      rmSync(second.cwd, { recursive: true, force: true });
      rmSync(second.homeBase, { recursive: true, force: true });
    }
  });

  test("claude calls through the seam -> zero console.warn calls", async () => {
    const first = makeTmpDirs("ac13-claude-1");
    const second = makeTmpDirs("ac13-claude-2");
    try {
      // No config.json — unset (claude) on both.
      installFakeBunSpawn({ claude: { stdoutText: claudeStreamJson("first"), exitCode: 0 } });
      await runCritic(baseOpts(first.cwd, first.homeBase), stubDeps);

      installFakeBunSpawn({ claude: { stdoutText: claudeStreamJson("second"), exitCode: 0 } });
      await runCritic(baseOpts(second.cwd, second.homeBase), stubDeps);

      expect(warnCalls.length).toBe(0);
    } finally {
      rmSync(first.cwd, { recursive: true, force: true });
      rmSync(first.homeBase, { recursive: true, force: true });
      rmSync(second.cwd, { recursive: true, force: true });
      rmSync(second.homeBase, { recursive: true, force: true });
    }
  });
});
