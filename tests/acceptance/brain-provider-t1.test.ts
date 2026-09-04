// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * INDEPENDENT acceptance test — track #7 T1 (cross-family Brain provider seam).
 *
 * Spec: an internal design note
 * Covers: AC1 (default-unchanged byte-identical argv) + AC9 mechanism half
 * (only the critic seam consults reviewer_provider; all other callBrain*
 * consumers keep claude by code).
 *
 * Exercises the system FROM OUTSIDE — driving the real `runCritic()` entry
 * point (the shared Stop-hook / `/siltpoke-review` callsite) with a temp
 * homeBase + config.json, rather than unit-testing loadReviewerProvider or
 * makeClaudeProvider in isolation.
 *
 * INJECTION-POINT NOTE (read before modifying): runCritic's own dependency
 * seam (`RunCriticDeps.callBrainFn`) would BYPASS the provider-selection code
 * under test — `deps.callBrainFn` short-circuits before runCritic ever calls
 * `loadReviewerProvider(homeBase)`. And `CallBrainOptions.spawnFn` (the field
 * brain.ts's runBrainCall reads via `opts.spawnFn ?? Bun.spawn`) is NEVER
 * populated by src/critic/phases/normal.ts or phases/passive-bubble.ts — both
 * build their callBrainFn payload as bare `{ systemPrompt, contextBundle }`
 * with no spawnFn field. So there is no in-band seam between "give runCritic
 * a homeBase and let it resolve the provider from config" and "observe the
 * literal argv Bun.spawn received" — the deepest injectable point that still
 * exercises real provider selection is the GLOBAL `Bun.spawn` binding itself,
 * which brain.ts falls back to. This file monkey-patches it for the duration
 * of each test (restored in afterEach) — this is a test-file-only seam, no
 * src/ change; it does not weaken the seam findings below, since the whole
 * point of AC1 is that the phases genuinely never had a per-call spawn hook.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBrainRaw, DEFAULT_MODEL } from "../../src/brain/brain";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { runCritic, type RunCriticDeps, type RunCriticOpts } from "../../src/critic/run-critic";
import type { RunToolsOpts, RunToolsResult } from "../../src/critic/tools/run-tools";

// [hardening] Control 1 (prompt-injection hardening, 2026-07-13):
// assembleSystemPrompt now mints a fresh crypto.randomUUID() nonce per
// assembly (fences the tool-output section), so the same static inputs no
// longer produce a byte-identical system prompt across two separate
// runCritic() calls — only the embedded nonce differs. Normalize it out
// before the byte-identical argv comparison below; AC1's actual claim (same
// code path, same provider routing → same argv SHAPE) is unaffected.
const NONCE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function normalizeNonce(argv: readonly string[]): string[] {
  return argv.map((a) => a.replace(NONCE_RE, "NONCE"));
}

// ---------------------------------------------------------------------------
// Global Bun.spawn patch plumbing — see file-header INJECTION-POINT NOTE.
// ---------------------------------------------------------------------------

const REAL_BUN_SPAWN = Bun.spawn;

type CapturedSpawnCall = { argv: string[] };

/**
 * Fake global Bun.spawn: for argv[0] === "claude" it returns a canned
 * successful (or deliberately-malformed) `claude -p --output-format json`
 * event stream; for anything else (e.g. the git-log fallback probe inside
 * runToolsPhase) it returns an immediate exit-1 process — no real
 * subprocess, network, or binary is ever touched.
 */
function installFakeBunSpawn(claudeResultText: () => string): CapturedSpawnCall[] {
  const calls: CapturedSpawnCall[] = [];
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
    argv: string[],
    _opts?: unknown,
  ) => {
    calls.push({ argv: [...argv] });
    if (argv[0] === "claude") {
      const streamJson = JSON.stringify([
        { type: "system", subtype: "init" },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: claudeResultText(),
          total_cost_usd: 0.001,
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 10,
            output_tokens: 5,
          },
        },
      ]);
      return {
        stdin: { write(_chunk: string) {}, end() {} },
        stdout: new Response(streamJson).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill() {},
      };
    }
    // Non-claude spawn (git fallback probe etc.) — immediate clean failure.
    return {
      stdin: { write(_chunk: string) {}, end() {} },
      stdout: new Response("").body,
      stderr: new Response("").body,
      exited: Promise.resolve(1),
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
// Fixtures
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

/** Schema-valid BrainOutput whose evidence snippet/file are drawn verbatim
 *  from the tsc diagnostic above, so the post-Brain evidence guard accepts it. */
const VALID_BRAIN_OUTPUT = {
  mood: "watching",
  pose: "base",
  bubble_short: "Found one thing worth a look.",
  bubble_long: "",
  critique_for_claude: "Minor tsc diagnostic worth a look.",
  severity: "low",
  confidence: "high",
  xp_earned_events: [],
  evidence: [
    {
      tool: "tsc",
      file: "src/example.ts",
      line: 10,
      snippet: "TS0000 error: Example diagnostic message for acceptance test",
    },
  ],
};

/** Schema-INVALID BrainOutput (bad SEVERITY enum) — proves callBrain's
 *  parseBrainOutput/schema-validation path is still engaged (AC1 "same schema path").
 *
 *  It used to be a bad MOOD. Since 2026-09-01 an out-of-range COSMETIC field is
 *  repaired rather than rejected, so a bad mood no longer reaches this path and
 *  this fixture stopped testing anything. `severity` is a JUDGEMENT and still
 *  rejects — substituting one would invent the verdict. */
const MALFORMED_BRAIN_OUTPUT = {
  mood: "happy",
  pose: "base",
  bubble_short: "x",
  bubble_long: "",
  critique_for_claude: "",
  severity: "not-a-real-severity",
  confidence: "high",
  xp_earned_events: [],
};

function writeConfig(homeBase: string, config: Record<string, unknown> | null): void {
  if (config === null) return; // no config.json at all — "unset" case
  writeFileSync(join(homeBase, "config.json"), JSON.stringify(config), "utf8");
}

function makeTmpDirs(): { cwd: string; homeBase: string } {
  const cwd = mkdtempSync(join(tmpdir(), "siltpoke-t1-cwd-"));
  const homeBase = mkdtempSync(join(tmpdir(), "siltpoke-t1-home-"));
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
      sessionId: "sess-t1-acceptance",
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

/** Runs runCritic through the REAL homeBase-driven provider seam (no
 *  deps.callBrainFn — that would bypass loadReviewerProvider entirely). */
async function runThroughProviderSeam(
  config: Record<string, unknown> | null,
  claudeResultText: () => string,
): Promise<{ calls: CapturedSpawnCall[]; result: Awaited<ReturnType<typeof runCritic>> }> {
  const { cwd, homeBase } = makeTmpDirs();
  try {
    writeConfig(homeBase, config);
    const calls = installFakeBunSpawn(claudeResultText);
    const result = await runCritic(baseOpts(cwd, homeBase), stubDeps);
    return { calls, result };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC1 — reviewer_provider unset (or "claude") is byte-identical to today.
// ---------------------------------------------------------------------------

describe("AC1 — reviewer_provider unset/claude: byte-identical argv + schema path", () => {
  test("unset (no config.json) produces the SAME argv as explicit reviewer_provider: claude", async () => {
    const unset = await runThroughProviderSeam(null, () => JSON.stringify(VALID_BRAIN_OUTPUT));
    const explicitClaude = await runThroughProviderSeam(
      { reviewer_provider: "claude" },
      () => JSON.stringify(VALID_BRAIN_OUTPUT),
    );

    const unsetClaudeCalls = unset.calls.filter((c) => c.argv[0] === "claude");
    const explicitClaudeCalls = explicitClaude.calls.filter((c) => c.argv[0] === "claude");

    expect(unsetClaudeCalls.length).toBe(1);
    expect(explicitClaudeCalls.length).toBe(1);

    // Byte-identical argv between "unset" and "claude" — same code path, same
    // static toolResults/systemPrompt inputs → deep array equality (modulo
    // the per-assembly nonce Control 1 embeds in the fenced tool-output
    // section — normalized out above, since it's expected to differ and
    // orthogonal to what AC1 asserts).
    expect(normalizeNonce(unsetClaudeCalls[0]!.argv)).toEqual(
      normalizeNonce(explicitClaudeCalls[0]!.argv),
    );

    // Shape check independent of the dynamically-assembled system prompt text.
    const argv = unsetClaudeCalls[0]!.argv;
    expect(argv.length).toBe(9);
    expect(argv[0]).toBe("claude");
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toBe("--model");
    expect(argv[3]).toBe(DEFAULT_MODEL);
    expect(argv[4]).toBe("--system-prompt");
    expect(typeof argv[5]).toBe("string");
    expect((argv[5] as string).length).toBeGreaterThan(0);
    expect(argv[6]).toBe("--output-format");
    expect(argv[7]).toBe("json");
    expect(argv[8]).toBe("--no-session-persistence");

    // Both runs reached the same gate decision (NORMAL) since default = claude.
    expect(unset.result.decision).toBe("NORMAL");
    expect(explicitClaude.result.decision).toBe("NORMAL");
  });

  test("schema path unchanged: a malformed claude response still fails the SAME brainOutputSchema validation (BrainError → HARD_SUPPRESS)", async () => {
    const { result } = await runThroughProviderSeam(null, () =>
      JSON.stringify(MALFORMED_BRAIN_OUTPUT),
    );

    expect(result.decision).toBe("HARD_SUPPRESS");
    if (result.decision === "HARD_SUPPRESS") {
      expect(result.reason).toContain("Brain response failed schema validation");
    }
  });

  test("reviewer_provider: codex changes observable behavior (proves the key IS honored) and never spawns claude", async () => {
    const { calls, result } = await runThroughProviderSeam(
      { reviewer_provider: "codex" },
      () => JSON.stringify(VALID_BRAIN_OUTPUT),
    );

    // T2 landed the real adapter: the key being honored is now observable as
    // a `codex` spawn (and never a `claude` one). The fake spawn's non-claude
    // branch replies with an immediate empty exit-1, so the call fails-soft.
    expect(calls.some((c) => c.argv[0] === "codex")).toBe(true);
    expect(calls.some((c) => c.argv[0] === "claude")).toBe(false);
    expect(result.decision).toBe("HARD_SUPPRESS");
  });

  test("SILTPOKE_REVIEWER_PROVIDER env override is honored in isolation (does not substitute for the config-file tests above)", async () => {
    process.env.SILTPOKE_REVIEWER_PROVIDER = "claude";
    const { calls, result } = await runThroughProviderSeam(
      { reviewer_provider: "codex" }, // config says codex...
      () => JSON.stringify(VALID_BRAIN_OUTPUT),
    );
    // ...but the env override wins, so we still see a claude spawn.
    expect(calls.some((c) => c.argv[0] === "claude")).toBe(true);
    expect(result.decision).toBe("NORMAL");
  });
});

// ---------------------------------------------------------------------------
// AC9 (mechanism half) — only the critic seam consults reviewer_provider.
// ---------------------------------------------------------------------------

describe("AC9 — allowlist mechanism: non-critic consumers keep claude by code", () => {
  const NON_CRITIC_CONSUMER_FILES = [
    "src/memory/summarizer.ts",
    "src/memory/extract-events.ts",
    "src/memory/nl-edit.ts",
    "src/memory/tag-entities.ts",
    "src/memory/synthesize-episodes.ts",
    "src/memory/extract-facts.ts",
    "src/chat/recap.ts",
    "src/explain/providers.ts",
    "src/explain/arch-generate.ts",
  ];

  test("mechanical: no non-critic consumer file imports provider-select", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    for (const rel of NON_CRITIC_CONSUMER_FILES) {
      const source = readFileSync(join(repoRoot, rel), "utf8");
      expect(source).not.toContain("provider-select");
      expect(source).not.toContain("loadReviewerProvider");
    }
  });

  test("behavioral: callBrainRaw (the memory-extractor / chat-recap primitive) spawns claude regardless of reviewer_provider", async () => {
    // Even with the env override set to codex — which AC1's dedicated test
    // above proves the CRITIC seam DOES honor — callBrainRaw never reads it.
    process.env.SILTPOKE_REVIEWER_PROVIDER = "codex";

    const capture: { argv?: string[] } = {};
    const fakeSpawn = ((argv: string[], _opts?: unknown) => {
      capture.argv = [...argv];
      const streamJson = JSON.stringify([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({ candidates: [] }),
          total_cost_usd: 0.0002,
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 5,
            output_tokens: 3,
          },
        },
      ]);
      return {
        stdin: { write(_chunk: string) {}, end() {} },
        stdout: new Response(streamJson).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;

    await callBrainRaw({ systemPrompt: "sp", contextBundle: "cb", spawnFn: fakeSpawn });

    expect(capture.argv?.[0]).toBe("claude");
    expect(capture.argv).not.toContain("codex");
  });
});
