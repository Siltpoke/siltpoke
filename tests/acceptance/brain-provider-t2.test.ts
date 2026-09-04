// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * INDEPENDENT acceptance test — track #7 T2 (codex adapter wired through the
 * real reviewer_provider seam).
 *
 * Spec: an internal design note
 * Covers: AC2 (codex exec argv shape + stdin payload + happy-path decision),
 * AC3 (schema-nonconformant codex output fails soft via the SAME zod gate),
 * AC5 (kill-timer — see UNTESTABLE note below), AC6 (usage normalization
 * observable on runCritic's return), AC10 classify half (turn.failed / ENOENT
 * -> classifyBrainFailure -> fail-soft, never a silent fallback to claude).
 *
 * Exercises the system FROM OUTSIDE — driving the real `runCritic()` entry
 * point with a temp homeBase + config.json (reviewer_provider: "codex"),
 * exactly like tests/acceptance/brain-provider-t1.test.ts. Same
 * INJECTION-POINT constraint applies here: CallBrainOptions.spawnFn is never
 * populated by src/critic/phases/normal.ts / phases/passive-bubble.ts (both
 * build `{ systemPrompt, contextBundle }` with no spawnFn/timeoutMs field),
 * so the only reachable seam from runCritic's outside is the GLOBAL
 * `Bun.spawn` binding that brain.ts / src/brain/providers/codex.ts fall back
 * to. This file monkey-patches it for the duration of each test (restored in
 * afterEach) — test-file-only seam, no src/ change.
 *
 * Fixtures: tests/brain/fixtures/codex/{happy,turn-failed,schema-violating}
 * .jsonl(+.stderr) — captured from live codex v0.142.5 probes (provenance
 * comments inside each fixture's first JSON line).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { runCritic, type RunCriticDeps, type RunCriticOpts } from "../../src/critic/run-critic";
import type { RunToolsOpts, RunToolsResult } from "../../src/critic/tools/run-tools";
import { readBrainHealth } from "../../src/state/brain-health";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "..", "brain", "fixtures", "codex");
const happyJsonl = readFileSync(join(FIXTURES, "happy.jsonl"), "utf8");
const happyStderr = readFileSync(join(FIXTURES, "happy.stderr"), "utf8");
const schemaViolatingJsonl = readFileSync(
  join(FIXTURES, "schema-violating.jsonl"),
  "utf8",
);
const turnFailedJsonl = readFileSync(join(FIXTURES, "turn-failed.jsonl"), "utf8");
const turnFailedStderr = readFileSync(
  join(FIXTURES, "turn-failed.stderr"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Global Bun.spawn patch plumbing — see file-header INJECTION-POINT note.
// ---------------------------------------------------------------------------

const REAL_BUN_SPAWN = Bun.spawn;

interface CapturedSpawnCall {
  argv: string[];
  stdinChunks: string[];
}

interface FakeSpawnResponse {
  stdoutText: string;
  stderrText?: string;
  exitCode?: number;
}

/**
 * Fake global Bun.spawn: replays a configured fixture response for `codex`
 * argv[0] (or throws synchronously to simulate a missing binary, mirroring
 * Bun's real "Executable not found in $PATH" spawn-time error) and for
 * `claude` argv[0] (only present so AC10's "never falls back to claude"
 * assertion has something concrete to check against — none of these tests
 * expect it to actually be invoked). Anything else gets an immediate exit-1
 * — no real subprocess, network, or binary is ever touched.
 */
function installFakeBunSpawn(cfg: {
  codex?: FakeSpawnResponse | "throw-enoent";
  claude?: FakeSpawnResponse;
}): CapturedSpawnCall[] {
  const calls: CapturedSpawnCall[] = [];
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
    argv: string[],
    _opts?: unknown,
  ) => {
    const stdinChunks: string[] = [];
    calls.push({ argv: [...argv], stdinChunks });

    if (argv[0] === "codex" && cfg.codex === "throw-enoent") {
      // Simulates Bun.spawn's real spawn-time failure for a missing binary
      // — thrown synchronously, BEFORE any process object is returned.
      throw new Error('Executable not found in $PATH: "codex"');
    }

    const resp: FakeSpawnResponse | undefined =
      argv[0] === "codex"
        ? (cfg.codex as FakeSpawnResponse | undefined)
        : argv[0] === "claude"
          ? cfg.claude
          : undefined;

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
// Shared test scaffolding (mirrors brain-provider-t1.test.ts's helpers)
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

/** One tsc diagnostic → classifyToolOutput reaches NORMAL (nonDiffSignal). */
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

function writeConfig(homeBase: string, config: Record<string, unknown>): void {
  writeFileSync(join(homeBase, "config.json"), JSON.stringify(config), "utf8");
}

function makeTmpDirs(): { cwd: string; homeBase: string } {
  const cwd = mkdtempSync(join(tmpdir(), "siltpoke-t2-cwd-"));
  const homeBase = mkdtempSync(join(tmpdir(), "siltpoke-t2-home-"));
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
      sessionId: "sess-t2-acceptance",
      cwd,
      stateBase: join(cwd, ".siltpoke"),
    },
    homeBase,
  };
}

const stubDeps: RunCriticDeps = {
  runToolsFn: stubRunToolsNormal,
  writeCritiqueFn: async () => ({ id: "stub-critique-id", path: "/dev/null" }),
};

/** normal.ts's literal contextBundle for the NORMAL-phase Brain call —
 *  asserted verbatim against the codex stdin payload below (AC2). */
const NORMAL_CONTEXT_BUNDLE = "Produce one Siltpoke JSON per the system prompt.";

// ---------------------------------------------------------------------------
// AC2 — codex exec argv shape + stdin payload + happy-path decision.
// ---------------------------------------------------------------------------

describe("AC2 — codex exec argv shape, stdin payload, happy-path decision", () => {
  test("spawns codex with the exact flag set (no -m), stdin carries contextBundle, happy fixture reaches a NORMAL decision from codex output", async () => {
    const { cwd, homeBase } = makeTmpDirs();
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      const calls = installFakeBunSpawn({
        codex: { stdoutText: happyJsonl, stderrText: happyStderr, exitCode: 0 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      const codexCalls = calls.filter((c) => c.argv[0] === "codex");
      expect(codexCalls.length).toBe(1);
      const argv = codexCalls[0]!.argv;

      // Exact flag set + order per AC2 / spec §2.
      expect(argv[0]).toBe("codex");
      expect(argv[1]).toBe("exec");
      expect(argv[2]).toBe("--json");
      expect(argv[3]).toBe("--ephemeral");
      expect(argv[4]).toBe("--skip-git-repo-check");
      expect(argv[5]).toBe("-s");
      expect(argv[6]).toBe("read-only");
      expect(argv[7]).toBe("-C");
      expect(typeof argv[8]).toBe("string");
      expect((argv[8] as string).length).toBeGreaterThan(0);
      expect(argv[9]).toBe("-c");
      expect(argv[10]).toMatch(/^developer_instructions=/);
      expect(argv[11]).toBe("--output-schema");
      expect(typeof argv[12]).toBe("string");
      expect((argv[12] as string).length).toBeGreaterThan(0);
      expect(argv[13]).toBe("-");
      expect(argv.length).toBe(14);

      // Never a `-m`/model-pin flag (AC contingency: rejected under ChatGPT auth).
      expect(argv).not.toContain("-m");

      // Payload arrives on stdin, not argv.
      expect(codexCalls[0]!.stdinChunks.join("")).toBe(NORMAL_CONTEXT_BUNDLE);

      // No fallback / dual-spawn to claude.
      expect(calls.some((c) => c.argv[0] === "claude")).toBe(false);

      // Happy fixture's agent_message drives the critic to a real decision.
      expect(result.decision).toBe("NORMAL");
      if (result.decision === "NORMAL") {
        expect(result.critique.bubble_short).toBe("looks good");
        expect(result.critique.mood).toBe("happy");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — schema-nonconformant codex output fails soft via the SAME zod gate.
// ---------------------------------------------------------------------------

describe("AC3 — codex output failing brainOutputSchema fails soft (no throw, review skipped)", () => {
  test("schema-violating fixture ({ok:true,n:3}) -> HARD_SUPPRESS, reason mentions schema validation, no crash", async () => {
    const { cwd, homeBase } = makeTmpDirs();
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      const calls = installFakeBunSpawn({
        codex: { stdoutText: schemaViolatingJsonl, exitCode: 0 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("HARD_SUPPRESS");
      if (result.decision === "HARD_SUPPRESS") {
        expect(result.reason).toContain("schema validation");
      }
      // fail-soft, not fail-open: never a silent claude retry.
      expect(calls.some((c) => c.argv[0] === "claude")).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — hung codex killed at timeoutMs.
// ---------------------------------------------------------------------------

describe("AC5 — hung codex killed at timeoutMs", () => {
  test.skip(
    "UNTESTABLE from outside runCritic (see reason): timeoutMs is never plumbed " +
      "from config/env through to CallBrainOptions on the critic seam. " +
      "src/critic/phases/normal.ts:148 and phases/passive-bubble.ts:106 both " +
      "build the callBrainFn payload as bare `{ systemPrompt, contextBundle }` " +
      "— no timeoutMs field. UPDATED 2026-08-23: that half is no longer true. " +
      "Both phases now forward `timeoutMs` from `<home>/config.json`'s " +
      "`brain.timeout_ms` (src/config/brain-timeout-config.ts), covered end to " +
      "end by tests/critic/brain-timeout-from-config.test.ts. This test stays " +
      "skipped for the OTHER reason below, which the config route does not " +
      "change: with no key set runCritic still drives the codex adapter with " +
      "its DEFAULT_CODEX_TIMEOUT_MS (120_000ms); an " +
      "acceptance test exercising the real kill-timer through runCritic would " +
      "have to wait out 2 real minutes per run, which is impractical. The " +
      "kill-timer IS covered at the unit layer, where timeoutMs is directly " +
      "injectable: tests/brain/providers/codex.test.ts test #9 'external " +
      "kill-timer fires at timeoutMs and calls proc.kill()' passes " +
      "timeoutMs: 20 straight to provider.call() against a spawnFn whose " +
      "`exited` promise never resolves on its own, and asserts both proc.kill() " +
      "fires and the call rejects with BrainError.",
    () => {},
  );
});

// ---------------------------------------------------------------------------
// AC6 — usage normalized at the adapter boundary, observable on runCritic's
// return (RunCriticResult's NORMAL/PASSIVE_BUBBLE branches carry `usage`
// straight from brainResult.usage — see src/critic/phases/normal.ts:166,
// 198, 252 and src/critic/types.ts:129-131).
// ---------------------------------------------------------------------------

describe("AC6 — usage normalized: input excludes cache reads, cache_creation 0, cost null", () => {
  test("happy fixture (input 15006 / cached 4992 / output 13) -> result.usage input_tokens=10014, cache_read=4992, cache_creation=0, cost null", async () => {
    const { cwd, homeBase } = makeTmpDirs();
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      installFakeBunSpawn({
        codex: { stdoutText: happyJsonl, stderrText: happyStderr, exitCode: 0 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("NORMAL");
      if (result.decision === "NORMAL") {
        expect(result.usage).toEqual({
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4992,
          input_tokens: 15006 - 4992, // 10014 — exclusive of cache reads
          output_tokens: 13,
          total_cost_usd: null, // quota billing — never a fabricated dollar figure
        });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC10 (classify half) — codex spawn/exit failures map into the existing
// classifyBrainFailure contract; fail-soft; NEVER a silent fallback to claude.
// The deepest observable point for the CLASS itself (beyond "it fails soft")
// is brain-health.json, written synchronously by makeGuardedCallBrain's
// recordAndEnrich before it rethrows — readable via readBrainHealth(homeBase)
// once runCritic has resolved.
// ---------------------------------------------------------------------------

describe("AC10 — codex failures classify + fail-soft + no silent fallback to claude", () => {
  test("turn.failed (real captured 400 auth/model-pin message) -> fail-soft HARD_SUPPRESS, classified ambiguous, never spawns claude", async () => {
    const { cwd, homeBase } = makeTmpDirs();
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      const calls = installFakeBunSpawn({
        codex: { stdoutText: turnFailedJsonl, stderrText: turnFailedStderr, exitCode: 1 },
      });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("HARD_SUPPRESS");
      expect(calls.filter((c) => c.argv[0] === "codex").length).toBe(1);
      expect(calls.some((c) => c.argv[0] === "claude")).toBe(false);

      // Classify half: the fixture's 400 "model not supported" text matches
      // none of the permanent/throttle/resource marker sets, so it falls to
      // the signed `ambiguous` contingency bucket — same class the unit-layer
      // test (tests/brain/providers/codex.test.ts) asserts for this exact
      // fixture via classifyBrainFailure() directly.
      const health = readBrainHealth(homeBase);
      expect(health.last_failure?.class).toBe("ambiguous");
      expect(health.last_failure?.exit_code).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });

  test("ENOENT (codex binary missing at spawn time) -> classified permanent, fail-soft, never spawns claude", async () => {
    const { cwd, homeBase } = makeTmpDirs();
    try {
      writeConfig(homeBase, { reviewer_provider: "codex" });
      const calls = installFakeBunSpawn({ codex: "throw-enoent" });

      const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);

      expect(result.decision).toBe("HARD_SUPPRESS");
      expect(calls.filter((c) => c.argv[0] === "codex").length).toBe(1);
      expect(calls.some((c) => c.argv[0] === "claude")).toBe(false);

      // Bun's real "Executable not found in $PATH" spawn error matches
      // failure-classify.ts's BINARY_MISSING_MARKER -> permanent (latched
      // breaker, doctor warn — never a quiet retry against a missing binary).
      const health = readBrainHealth(homeBase);
      expect(health.last_failure?.class).toBe("permanent");
      expect(health.last_failure?.exit_code).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });
});
