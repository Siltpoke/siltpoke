// Honesty round: breaker pre-check in the Stop hook +
// empty-bubble write suppression at the 3 writers in handle-stop.ts.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStopHook } from "../../../src/hooks/handle-stop";
import type { BrainCallResult } from "../../../src/brain/brain";
import type { RunCriticDeps } from "../../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../../src/critic/tools/types";
import type { BrainOutput } from "../../../src/brain/schema";
import {
  freshBrainHealth,
  recordFailure,
  readBrainHealth,
  writeBrainHealth,
} from "../../../src/state/brain-health";
import { eventWithProj, noopUsage } from "./_shared";

let tmpHome: string;
let homeBase: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-breaker-"));
  homeBase = join(tmpHome, ".siltpoke");
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function brainOut(overrides?: Partial<BrainOutput>): BrainOutput {
  return {
    mood: "happy",
    pose: "base",
    bubble_short: "ok",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
    reasoning: "test fixture",
    ...overrides,
  };
}

function openResourceBreakerNow(): ReturnType<typeof recordFailure> {
  return recordFailure(freshBrainHealth(), {
    class: "resource",
    exit_code: 137,
    stderr_excerpt: "EAGAIN",
    ts: new Date().toISOString(),
  });
}

// ── Open breaker → no spawn + skip record ────────────────────────────────────

test("open breaker: Stop hook skips the Brain spawn and writes a skip record with the breaker reason", async () => {
  writeBrainHealth(homeBase, openResourceBreakerNow());

  let brainCalled = false;
  const event = eventWithProj(tmpHome, "breaker-skip");
  await handleStopHook(event as never, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (): Promise<BrainCallResult> => {
      brainCalled = true;
      return { output: brainOut(), usage: noopUsage };
    },
  });

  expect(brainCalled).toBe(false);
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"skipped":"brain_breaker_open"');
  expect(log).toContain('"breaker_class":"resource"');
});

test("/siltpoke-wake clears the breaker (incl. latched permanent) and the call proceeds", async () => {
  const latched = recordFailure(freshBrainHealth(), {
    class: "permanent",
    exit_code: 1,
    stderr_excerpt: "Invalid API key",
    ts: new Date().toISOString(),
  });
  writeBrainHealth(homeBase, latched);
  await writeFile(
    join(homeBase, "wake.json"),
    JSON.stringify({ schemaVersion: 1, expires_at_ms: Date.now() + 300_000 }),
  );

  let brainCalled = false;
  const event = eventWithProj(tmpHome, "breaker-wake");
  await handleStopHook(event as never, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (): Promise<BrainCallResult> => {
      brainCalled = true;
      return { output: brainOut(), usage: noopUsage };
    },
  });

  expect(brainCalled).toBe(true);
  expect(readBrainHealth(homeBase).breaker).toBeNull();
});

// ── Empty effective bubble → no state write, jsonl still written ────────────

test("legacy writer (~616): low-confidence turn writes NO state file; jsonl telemetry flagged bubble_suppressed", async () => {
  const event = eventWithProj(tmpHome, "suppress-legacy");
  await handleStopHook(event as never, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (): Promise<BrainCallResult> => ({
      output: brainOut({ confidence: "low", bubble_short: "should not surface" }),
      usage: noopUsage,
    }),
  });

  // No activity/state write for the empty effective bubble…
  expect(existsSync(join(event.cwd, ".siltpoke", "state.json"))).toBe(false);
  // …but the jsonl telemetry line IS still written, flagged for the render filter.
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"bubble_suppressed":true');
  expect(log).toContain("should not surface"); // honest telemetry retains the original
});

// ── m112-path fixtures (mirrors tests/critic/run-critic.test.ts shapes) ──────

function makeCleanWithDiff(): Record<ToolName, ToolResult> & {
  securityFindings: never[]; owaspHints: never[]; webSearchSources: never[];
} {
  return {
    tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
    eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
    "git-diff": {
      tool: "git-diff",
      status: "ok",
      parsed: [{
        file: "src/foo.ts", oldStart: 1, oldLines: 5, newStart: 1, newLines: 5,
        header: "@@ -1,5 +1,5 @@", body: "-old line\n+new line",
      }],
      raw: "diff --git a/src/foo.ts b/src/foo.ts",
    },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

const REAL_SNIPPET = "let x: string = badValue;";

function makeWithTscError(): Record<ToolName, ToolResult> & {
  securityFindings: never[]; owaspHints: never[]; webSearchSources: never[];
} {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [{
        file: "src/dummy.ts", line: 5, col: 1, severity: "error",
        code: "TS2322", message: "Type mismatch.",
      }],
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

test("m112 NORMAL writer (~506): low-confidence accepted critique writes NO state file; jsonl flagged", async () => {
  const event = eventWithProj(tmpHome, "suppress-normal");
  const deps: RunCriticDeps = {
    runToolsFn: async () => makeWithTscError(),
    callBrainFn: async (): Promise<BrainCallResult> => ({
      output: brainOut({
        bubble_short: "low conf finding",
        severity: "medium",
        confidence: "low",
        evidence: [{ tool: "tsc", file: "src/dummy.ts", line: 5, snippet: REAL_SNIPPET }],
      }),
      usage: noopUsage,
    }),
    writeCritiqueFn: async () => ({ id: "c-low", path: "/tmp/x" }),
  };

  await handleStopHook(event as never, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    m112Deps: deps,
  });

  expect(existsSync(join(event.cwd, ".siltpoke", "state.json"))).toBe(false);
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"bubble_suppressed":true');
});

test("PASSIVE_BUBBLE writer (~437): empty bubble_short writes NO state file; jsonl flagged + carries usage", async () => {
  const event = eventWithProj(tmpHome, "suppress-passive");
  const deps: RunCriticDeps = {
    runToolsFn: async () => makeCleanWithDiff(),
    callBrainFn: async (): Promise<BrainCallResult> => ({
      output: brainOut({ bubble_short: "", critique_for_claude: "" }),
      usage: {
        input_tokens: 42,
        output_tokens: 17,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 0,
        total_cost_usd: 0.001,
      },
    }),
    writeCritiqueFn: async () => ({ id: "c-passive-empty", path: "/tmp/x" }),
  };

  await handleStopHook(event as never, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "1" },
    m112Deps: deps,
  });

  expect(existsSync(join(event.cwd, ".siltpoke", "state.json"))).toBe(false);
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"bubble_suppressed":true');
  // The PASSIVE_BUBBLE fired line carries the Brain usage block (rail/header
  // token+cost readout parses `usage` off this line) — pinned per-path, the
  // NORMAL path is pinned in handle-stop.test.ts.
  const pb = log
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l["critic_path_decision"] === "PASSIVE_BUBBLE");
  const usage = pb?.["usage"] as Record<string, unknown> | undefined;
  expect(usage?.["input_tokens"]).toBe(42);
  expect(usage?.["cache_read_input_tokens"]).toBe(300);
});

test("control: non-empty effective bubble still writes state (no over-suppression)", async () => {
  const event = eventWithProj(tmpHome, "no-suppress");
  await handleStopHook(event as never, {
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async (): Promise<BrainCallResult> => ({
      output: brainOut({ confidence: "high", bubble_short: "real bubble" }),
      usage: noopUsage,
    }),
  });
  const state = JSON.parse(
    readFileSync(join(event.cwd, ".siltpoke", "state.json"), "utf8"),
  );
  expect(state.bubble_short).toBe("real bubble");
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).not.toContain('"bubble_suppressed"');
});
