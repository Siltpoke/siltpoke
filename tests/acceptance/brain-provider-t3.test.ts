// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * INDEPENDENT acceptance test — track #7 T3 (ledger/telemetry provider truth).
 *
 * Spec: an internal design note
 * Covers: AC7 (ledger/telemetry rows carry provider/billing/model; quota
 * calls cost null; historical rows read as claude/usd, no rewrite), AC14
 * (spans for codex calls do not claim gen_ai.system "anthropic"), AC8
 * (null-render half — readers render null-cost rows visible-but-$0), and
 * the T2-deferred item (reviewed-repo cwd reaches codex argv -C, not the
 * daemon's process.cwd()).
 *
 * DRIVING SURFACE — one level deeper than T1/T2: `handleStopHook` itself,
 * not `runCritic` directly. handle-stop.ts is the ONE writer of both ledger
 * files (brain-calls.jsonl via appendJsonLine, usage-events.jsonl via
 * appendUsageEvent) AND the constructor of the real Tracer/TraceStore pair
 * (homeBase/traces/*.jsonl) — so it is the deepest outside entry that can
 * exercise ledger + span writing in one call. Per run-critic.ts:135-152,
 * REAL provider resolution (`loadReviewerProvider(homeBase)` reading
 * `<homeBase>/config.json`) only happens when `deps.callBrainFn` is
 * UNDEFINED — so `opts.m112Deps` here supplies `runToolsFn` +
 * `writeCritiqueFn` only (mirroring T1/T2's `stubDeps`), never
 * `callBrainFn`/`providerMeta`. This is deliberately NOT the same seam the
 * new (uncommitted) handle-stop.test.ts "Part 2b" tests use — those inject
 * `providerMeta`/`servedModel` directly (a unit-level seam bypassing real
 * config resolution); this file proves the same ledger truth end-to-end
 * from a real `~/.siltpoke/config.json` + a real (fake-Bun.spawn) subprocess
 * call, which is what AC7/AC14/T2-deferred actually promise the user.
 *
 * Fixtures: reuses tests/acceptance/brain-provider-t1.test.ts's
 * VALID_BRAIN_OUTPUT evidence shape (file/line/snippet drawn verbatim from
 * the shared tsc-diagnostic stub) so the post-Brain evidence guard ACCEPTS
 * the critique on both the claude-default and codex-configured runs —
 * giving a clean NORMAL/accepted:true row on both sides, which is the
 * strongest form of "everything else keeps working" (AC7's ledger honesty
 * promise is best proven against a row that actually persisted a critique,
 * not one the guard silently dropped). The codex agent_message is
 * hand-built (not read from tests/brain/fixtures/codex/happy.jsonl) because
 * that fixture's own agent_message carries an EMPTY evidence array, which
 * NORMAL-mode guardCritique unconditionally rejects (src/critic/
 * evidence-guard.ts:53) — fine for T2 (which never asserted `.accepted`),
 * not fine here where we want to observe the full write path (state.json +
 * critique persistence + XP) alongside the ledger fields. codex JSONL event
 * envelope shape (thread.started / turn.started / item.completed
 * agent_message / turn.completed usage) mirrors the real fixture's shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL } from "../../src/brain/brain";
import { handleStopHook } from "../../src/hooks/handle-stop";
import type { HookEvent } from "../../src/router/router";
import { readBrainCalls } from "../../src/state/critic-event-log";
import { BlockF } from "../../src/web/primitives/CritiqueAuditBlocks";
import { makeGitRepo } from "../_shared/git-fixture";

// ---------------------------------------------------------------------------
// Global Bun.spawn patch plumbing (mirrors brain-provider-t1/t2.test.ts).
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
 * Fake global Bun.spawn: replays configured responses for `codex`/`claude`
 * argv[0]; anything else (git-log fallback probe inside runToolsPhase,
 * git-baseline capture inside handle-stop.ts's tool-augmented path) gets an
 * immediate clean exit-1 — no real subprocess, network, or binary touched.
 * Same default-fallback design as brain-provider-t1.test.ts's
 * installFakeBunSpawn (there documented as covering exactly this case).
 */
function installFakeBunSpawn(cfg: {
  codex?: FakeSpawnResponse;
  claude?: FakeSpawnResponse;
}): CapturedSpawnCall[] {
  const calls: CapturedSpawnCall[] = [];
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
    argv: string[],
    _opts?: unknown,
  ) => {
    const stdinChunks: string[] = [];
    calls.push({ argv: [...argv], stdinChunks });
    // `git` runs for real. The ⏱ review-unit gate asks git whether a unit of
    // work closed, and answering every git call with exit 1 makes the fixture
    // repo look like "not a git repo" — the hook then skips before any provider
    // is resolved, and this test would report zero codex spawns for a reason
    // that has nothing to do with providers. The codex/claude assertions below
    // are unaffected: those argv[0]s never reach this branch.
    if (argv[0] === "git") {
      return (REAL_BUN_SPAWN as unknown as (a: string[], o?: unknown) => unknown)(argv, _opts);
    }
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
// Shared test scaffolding (mirrors tests/hooks/handle-stop.test.ts's helpers).
// ---------------------------------------------------------------------------

function makeTranscriptWithEdit(dir: string, filePath?: string): string {
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

function makeStopEvent(sessionId: string, transcriptPath: string, cwd: string): HookEvent {
  // A real repo: the ⏱ review-unit gate answers a cwd git knows nothing about
  // with `not_a_git_repo` and skips before any provider is ever resolved.
  makeGitRepo(cwd);
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  };
}

/** One tsc diagnostic → classifyToolOutput reaches NORMAL. Identical stub to
 *  brain-provider-t1/t2.test.ts's stubRunToolsNormal — the evidence fixtures
 *  below are hand-picked to match THIS exact file/line/message. */
async function stubRunToolsNormal() {
  return {
    tsc: {
      tool: "tsc" as const,
      status: "ok" as const,
      parsed: [
        {
          file: "src/example.ts",
          line: 10,
          col: 5,
          severity: "error" as const,
          code: "TS0000",
          message: "Example diagnostic message for acceptance test",
        },
      ],
      raw: "",
    },
    eslint: { tool: "eslint" as const, status: "not_applicable" as const, parsed: [], raw: "" },
    "git-diff": { tool: "git-diff" as const, status: "ok" as const, parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep" as const, status: "not_applicable" as const, parsed: [], raw: "" },
    securityFindings: [] as never[],
    owaspHints: [] as never[],
    webSearchSources: [] as never[],
  };
}

/** All not_applicable → classifyToolOutput reaches HARD_SUPPRESS. */
async function stubRunToolsSuppress() {
  return {
    tsc: { tool: "tsc" as const, status: "not_applicable" as const, parsed: [], raw: "" },
    eslint: { tool: "eslint" as const, status: "not_applicable" as const, parsed: [], raw: "" },
    "git-diff": { tool: "git-diff" as const, status: "not_applicable" as const, parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep" as const, status: "not_applicable" as const, parsed: [], raw: "" },
    securityFindings: [] as never[],
    owaspHints: [] as never[],
    webSearchSources: [] as never[],
  };
}

async function stubWriteCritique() {
  return { id: "stub-critique-id-t3", path: "/dev/null" };
}

/** Evidence drawn verbatim from stubRunToolsNormal's tsc diagnostic — see
 *  brain-provider-t1.test.ts's VALID_BRAIN_OUTPUT (same shape, same
 *  rationale: "so the post-Brain evidence guard accepts it"). */
const ACCEPTED_EVIDENCE = [
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
    evidence: ACCEPTED_EVIDENCE,
  };
}

function writeReviewerConfig(homeSilt: string, config: Record<string, unknown>): void {
  mkdirSync(homeSilt, { recursive: true });
  writeFileSync(join(homeSilt, "config.json"), JSON.stringify(config), "utf8");
}

function makeTmpDirs(prefix: string): { tmpHome: string; projectCwd: string } {
  const tmpHome = mkdtempSync(join(tmpdir(), `siltpoke-t3-home-${prefix}-`));
  const projectCwd = mkdtempSync(join(tmpdir(), `siltpoke-t3-proj-${prefix}-`));
  mkdirSync(join(projectCwd, ".siltpoke"), { recursive: true });
  return { tmpHome, projectCwd };
}

function lastJsonlLine(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

/** Reads today's OTEL span partition written by handleStopHook's real
 *  Tracer/TraceStore pair (homeBase/traces/{day}.jsonl — see handle-stop.ts's
 *  m112Enabled branch, which constructs both unconditionally). */
function findBrainFindSpan(tmpHome: string): Record<string, unknown> | undefined {
  const day = new Date().toISOString().slice(0, 10);
  const path = join(tmpHome, ".siltpoke", "traces", `${day}.jsonl`);
  if (!existsSync(path)) return undefined;
  const spans = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return spans.filter((s) => s.name === "siltpoke.brain.find").pop();
}

// ---------------------------------------------------------------------------
// AC7 + AC14 + T2-deferred — codex-configured run, real provider resolution.
// ---------------------------------------------------------------------------

describe("AC7/AC14/T2-deferred — handleStopHook + reviewer_provider:codex (real config, fake spawn)", () => {
  test("brain-calls.jsonl + usage-events.jsonl carry provider=codex/billing=quota/model; span gen_ai.system=openai; -C carries the reviewed-repo cwd (not process.cwd())", async () => {
    const { tmpHome, projectCwd } = makeTmpDirs("codex");
    try {
      writeReviewerConfig(join(tmpHome, ".siltpoke"), { reviewer_provider: "codex" });
      const transcriptPath = makeTranscriptWithEdit(tmpHome);

      const codexEvents = [
        JSON.stringify({ type: "thread.started", thread_id: "t3-thread" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: JSON.stringify(acceptedBrainOutput("Codex found a type slip.")) },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 15006, cached_input_tokens: 4992, output_tokens: 13, reasoning_output_tokens: 0 },
        }),
      ].join("\n");
      // Model banner on its own line — servedModelFromStderr's regex is the
      // FIRST source consulted (ahead of ~/.codex/config.toml), so this
      // fixture's servedModel is deterministic regardless of the machine's
      // real codex config (src/brain/providers/codex.ts:141-143).
      const codexStderr = "Reading additional input from stdin...\nmodel: codex-test-model-x1\n";

      const calls = installFakeBunSpawn({
        codex: { stdoutText: codexEvents, stderrText: codexStderr, exitCode: 0 },
      });

      await handleStopHook(
        makeStopEvent("sess-t3-codex", transcriptPath, projectCwd),
        {
          env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
          m112Deps: { runToolsFn: stubRunToolsNormal, writeCritiqueFn: stubWriteCritique },
          // T5 fired-path side effects (menu-bar refresh + osascript notify)
          // are real spawnSync calls on darwin — stub so this NORMAL-accepted
          // test never shells out to open/osascript on a dev Mac.
          menubarDeps: { exec: () => {} },
        },
      );

      // --- no fallback to claude; exactly one codex spawn ---
      const codexCalls = calls.filter((c) => c.argv[0] === "codex");
      expect(codexCalls.length).toBe(1);
      // "No fallback to claude" is a claim about the REVIEWER. The Haiku
      // diff-summary pre-pass is also a `claude` spawn and always has been —
      // it only became visible here once the fixture cwd was a real repo, so
      // the recent-commits fallback had something to summarize. Excluding it
      // by its own system prompt keeps this assertion about the thing it
      // names; a bare `argv[0] === "claude"` would now fail for a reason that
      // has nothing to do with provider routing.
      const reviewerClaudeCalls = calls.filter(
        (c) => c.argv[0] === "claude" && !c.argv.some((a) => a.includes("code-diff summarizer")),
      );
      expect(reviewerClaudeCalls).toEqual([]);

      // --- T2-deferred: -C carries the REVIEWED-repo cwd, not process.cwd() ---
      const argv = codexCalls[0]!.argv;
      const cIndex = argv.indexOf("-C");
      expect(cIndex).toBeGreaterThan(-1);
      expect(argv[cIndex + 1]).toBe(projectCwd);
      expect(argv[cIndex + 1]).not.toBe(process.cwd());

      // --- AC7: brain-calls.jsonl ---
      const homeSilt = join(tmpHome, ".siltpoke");
      const line = lastJsonlLine(join(homeSilt, "brain-calls.jsonl"));
      expect(line.critic_path_decision).toBe("NORMAL");
      expect(line.m112_accepted).toBe(true);
      expect(line.provider).toBe("codex");
      expect(line.billing).toBe("quota");
      expect(line.model).toBe("codex-test-model-x1");
      const usageOnLine = line.usage as Record<string, unknown>;
      expect(usageOnLine.total_cost_usd).toBeNull();
      expect(usageOnLine.input_tokens).toBe(15006 - 4992); // exclusive of cache reads
      expect(usageOnLine.output_tokens).toBe(13);

      // --- AC7: usage-events.jsonl ---
      const usageEvent = lastJsonlLine(join(homeSilt, "usage-events.jsonl"));
      expect(usageEvent.provider).toBe("codex");
      expect(usageEvent.billing).toBe("quota");
      expect(usageEvent.model).toBe("codex-test-model-x1");
      expect(usageEvent.total_cost_usd).toBeNull();
      expect(usageEvent.input_tokens).toBe(15006 - 4992);
      expect(usageEvent.output_tokens).toBe(13);

      // --- AC14: real OTEL span never claims anthropic for a codex call ---
      const span = findBrainFindSpan(tmpHome);
      expect(span).toBeDefined();
      const attrs = span!.attributes as Record<string, unknown>;
      expect(attrs["gen_ai.system"]).toBe("openai");
      expect(attrs["gen_ai.system"]).not.toBe("anthropic");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC7 + AC14 contrast case — default/unset reviewer_provider (claude, usd).
// ---------------------------------------------------------------------------

describe("AC7/AC14 — handleStopHook default path (no config.json): provider=claude/billing=usd", () => {
  test("brain-calls.jsonl + usage-events.jsonl carry provider=claude/billing=usd/model=DEFAULT_MODEL, real cost; span gen_ai.system=anthropic", async () => {
    const { tmpHome, projectCwd } = makeTmpDirs("claude-default");
    try {
      // No config.json at all — "unset" per AC1/AC7 historical-compatible default.
      const transcriptPath = makeTranscriptWithEdit(tmpHome);

      const claudeStreamJson = JSON.stringify([
        { type: "system", subtype: "init" },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify(acceptedBrainOutput("Type mismatch worth a look.")),
          total_cost_usd: 0.001,
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 10,
            output_tokens: 5,
          },
        },
      ]);
      const calls = installFakeBunSpawn({ claude: { stdoutText: claudeStreamJson, exitCode: 0 } });

      await handleStopHook(
        makeStopEvent("sess-t3-claude-default", transcriptPath, projectCwd),
        {
          env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
          m112Deps: { runToolsFn: stubRunToolsNormal, writeCritiqueFn: stubWriteCritique },
          // T5 fired-path side effects — stub so this NORMAL-accepted test
          // never shells out to open/osascript on a dev Mac.
          menubarDeps: { exec: () => {} },
        },
      );

      expect(calls.some((c) => c.argv[0] === "claude")).toBe(true);
      expect(calls.some((c) => c.argv[0] === "codex")).toBe(false);

      const homeSilt = join(tmpHome, ".siltpoke");
      const line = lastJsonlLine(join(homeSilt, "brain-calls.jsonl"));
      expect(line.critic_path_decision).toBe("NORMAL");
      expect(line.m112_accepted).toBe(true);
      expect(line.provider).toBe("claude");
      expect(line.billing).toBe("usd");
      expect(line.model).toBe(DEFAULT_MODEL);
      const usageOnLine = line.usage as Record<string, unknown>;
      expect(usageOnLine.total_cost_usd).toBe(0.001);

      const usageEvent = lastJsonlLine(join(homeSilt, "usage-events.jsonl"));
      expect(usageEvent.provider).toBe("claude");
      expect(usageEvent.billing).toBe("usd");
      expect(usageEvent.model).toBe(DEFAULT_MODEL);
      expect(usageEvent.total_cost_usd).toBe(0.001);

      const span = findBrainFindSpan(tmpHome);
      expect(span).toBeDefined();
      const attrs = span!.attributes as Record<string, unknown>;
      expect(attrs["gen_ai.system"]).toBe("anthropic");
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC7 — HARD_SUPPRESS still carries the real-resolved provider even though
// no Brain call (and so no spawn at all) ever happens.
// ---------------------------------------------------------------------------

describe("AC7 — HARD_SUPPRESS row carries real-resolved provider with zero spawns", () => {
  test("reviewer_provider:codex configured, tools all not_applicable -> HARD_SUPPRESS, provider=codex/billing=quota, no model, zero codex/claude spawns", async () => {
    const { tmpHome, projectCwd } = makeTmpDirs("suppress");
    try {
      writeReviewerConfig(join(tmpHome, ".siltpoke"), { reviewer_provider: "codex" });
      const transcriptPath = makeTranscriptWithEdit(tmpHome);
      // Safety net: proves no codex/claude spawn was attempted (tool
      // classification short-circuits before any Brain call).
      const calls = installFakeBunSpawn({});

      await handleStopHook(
        makeStopEvent("sess-t3-suppress", transcriptPath, projectCwd),
        {
          env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
          m112Deps: { runToolsFn: stubRunToolsSuppress, writeCritiqueFn: stubWriteCritique },
        },
      );

      expect(calls.some((c) => c.argv[0] === "codex")).toBe(false);
      expect(calls.some((c) => c.argv[0] === "claude")).toBe(false);

      const homeSilt = join(tmpHome, ".siltpoke");
      const line = lastJsonlLine(join(homeSilt, "brain-calls.jsonl"));
      expect(line.critic_path_decision).toBe("HARD_SUPPRESS");
      expect(line.provider).toBe("codex");
      expect(line.billing).toBe("quota");
      // No Brain call happened — no served-model to report.
      expect(line.model).toBeUndefined();
      // No Brain call -> no usage-events.jsonl at all.
      expect(existsSync(join(homeSilt, "usage-events.jsonl"))).toBe(false);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(projectCwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC7 (historical-row read path) + AC8 (null-render half) — via the PUBLIC
// read path (readBrainCalls, real disk I/O) chained into the PUBLIC render
// surface (BlockF), rather than feeding literal objects to parseCall
// directly (that unit-level coverage already lives in
// tests/state/critic-event-log-parse.test.ts and
// tests/web/primitives/CritiqueAuditBlocks.test.tsx).
// ---------------------------------------------------------------------------

describe("AC7 (historical-row reader) + AC8 (null-render) — disk write -> readBrainCalls -> BlockF render", () => {
  test("a historical row (no provider/billing/model) reads as claude/usd/null with its real cost intact; a codex row reads through with null cost VISIBLE (tokens render, no $ line, no placeholder)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-t3-readpath-"));
    try {
      const historicalRow = {
        timestamp: new Date().toISOString(),
        session_id: "sess-t3-historical",
        cwd: "/repo/legacy-proj",
        critic_path_decision: "NORMAL",
        m112_accepted: true,
        brain_output: { bubble_short: "legacy bubble", severity: "low", confidence: "high" },
        usage: {
          input_tokens: 200,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          total_cost_usd: 0.0021,
        },
        // NO provider/billing/model keys at all — every pre-track row.
      };
      const codexRow = {
        timestamp: new Date().toISOString(),
        session_id: "sess-t3-codex-row",
        cwd: "/repo/codex-proj",
        critic_path_decision: "NORMAL",
        m112_accepted: true,
        brain_output: { bubble_short: "codex bubble", severity: "low", confidence: "high" },
        usage: {
          input_tokens: 500,
          output_tokens: 120,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          total_cost_usd: null, // quota billing — never a fabricated dollar figure
        },
        provider: "codex",
        billing: "quota",
        model: "gpt-5-codex",
      };
      writeFileSync(
        join(dir, "brain-calls.jsonl"),
        `${JSON.stringify(historicalRow)}\n${JSON.stringify(codexRow)}\n`,
        "utf8",
      );

      const { calls } = await readBrainCalls(dir);
      const historical = calls.find((c) => c.session_id === "sess-t3-historical");
      const codex = calls.find((c) => c.session_id === "sess-t3-codex-row");
      expect(historical).toBeDefined();
      expect(codex).toBeDefined();

      // AC7 — historical-row-compatible defaults, real cost preserved.
      expect(historical!.provider).toBe("claude");
      expect(historical!.billing).toBe("usd");
      expect(historical!.model).toBeNull();
      expect(historical!.cost_usd).toBe(0.0021);

      // AC7 — codex row passes through provider truth + null cost.
      expect(codex!.provider).toBe("codex");
      expect(codex!.billing).toBe("quota");
      expect(codex!.model).toBe("gpt-5-codex");
      expect(codex!.cost_usd).toBeNull();
      expect(codex!.tokens).toEqual({ input: 500, output: 120, cache_read: 0, cache_create: 0 });

      // AC8 — render the REAL parsed rows (not hand-built literals) through
      // the real dashboard component. A quota-billed null-cost row must stay
      // visible with its token counts; only the $ line is omitted — no
      // placeholder, no crash, no fabricated "$0.0000".
      const historicalHtml = String(BlockF({ v2: null, c: historical! }));
      expect(historicalHtml).toContain("0.0021");

      const codexHtml = String(BlockF({ v2: null, c: codex! }));
      expect(codexHtml).toContain("input: 500");
      expect(codexHtml).toContain("output: 120");
      expect(codexHtml).not.toContain("no cost data");
      expect(codexHtml).not.toContain("$ ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
