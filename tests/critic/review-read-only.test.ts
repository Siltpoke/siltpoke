// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The review's claude may only read files.
 *
 * Its prompt carries the diff — text from the reviewed repo — and `claude -p`
 * started with every tool, the shell and the user's MCP servers included. The
 * dashboard chat got the same limit in #1053. Before this change, 48 replays of
 * 8 real reviews made 0 tool calls with or without the limit, so it removes
 * nothing the review used.
 *
 * Two halves, both asserted: every review path ASKS for read-only (both phases,
 * and the SILTPOKE_TOOL_AUGMENTED=0 legacy path), and the ask
 * reaches the spawned argv through the production chain (guarded wrapper →
 * claude provider → runBrainCall). A call that does not ask keeps every tool.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainCallResult, CallBrainOptions } from "../../src/brain/brain";
import { makeGuardedCallBrain } from "../../src/brain/brain-guarded";
import { makeClaudeProvider } from "../../src/brain/provider";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { runCritic } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { runHook } from "../../src/hooks/on-stop";
import { eventWithProj, fakeBrainOutput, noopUsage } from "../hooks/on-stop/_shared";

const OUTPUT = {
  mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
  critique_for_claude: "", severity: "info", confidence: "medium",
  xp_earned_events: [], evidence: [], findings: [],
} as const;

function caps(): ProjectCapabilities {
  return {
    cwd: "/tmp/test", hasGit: true, hasTsc: false, hasEslint: false,
    hasRipgrep: false, tsconfigPaths: [], eslintConfigPaths: [],
    detectedAt: Date.now(), configMtimes: {},
  };
}

function na(tool: ToolName): ToolResult {
  return { tool, status: "not_applicable", parsed: [], raw: "" } as ToolResult;
}

/** Run one review turn; report the decision and the options the Brain was given. */
async function reviewTurn(ripgrepHit: boolean): Promise<{ decision: string; seen: CallBrainOptions[] }> {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-readonly-"));
  mkdirSync(join(home, "state"), { recursive: true });
  const seen: CallBrainOptions[] = [];
  const ripgrep: ToolResult = ripgrepHit
    ? { tool: "ripgrep", status: "ok", parsed: [{ file: "src/foo.ts", line: 1, text: "eval(x)", pattern: "eval" }], raw: "src/foo.ts:1:eval(x)" }
    : na("ripgrep");
  try {
    const result = await runCritic(
      {
        source: "stop-hook",
        cwd: "/tmp/test",
        changedFiles: ["src/foo.ts"],
        caps: caps(),
        homeBase: home,
        brainContext: {
          personalitySystemPrompt: "You are Siltpoke.",
          memory: null, recent: [], sessionId: "s1",
          cwd: "/tmp/test", stateBase: join(home, "state"),
        },
      },
      {
        runToolsFn: async () => ({
          tsc: na("tsc"), eslint: na("eslint"),
          "git-diff": { tool: "git-diff", status: "ok", parsed: [{ file: "src/foo.ts", header: "@@", body: "+eval(x)" }], raw: "" } as ToolResult,
          ripgrep,
          securityFindings: [], owaspHints: [], webSearchSources: [],
        }),
        callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
          seen.push(opts);
          return { output: OUTPUT as never, usage: { input_tokens: 1, output_tokens: 1 } as never };
        },
        writeCritiqueFn: async () => ({ id: "c-test", path: "/tmp/c-test.md" }),
      },
    );
    return { decision: result.decision, seen };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("both review phases ask for read-only", () => {
  test("NORMAL", async () => {
    const { decision, seen } = await reviewTurn(true);
    expect(decision).toBe("NORMAL");
    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) expect(opts.readOnly).toBe(true);
    // And without the reviewed folder's project settings (its hooks ran, 2026-10-20).
    for (const opts of seen) expect(opts.projectSettingsOff).toBe(true);
  });

  test("PASSIVE_BUBBLE", async () => {
    const { decision, seen } = await reviewTurn(false);
    expect(decision).toBe("PASSIVE_BUBBLE");
    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) expect(opts.readOnly).toBe(true);
    for (const opts of seen) expect(opts.projectSettingsOff).toBe(true);
  });
});

describe("the legacy review path (SILTPOKE_TOOL_AUGMENTED=0) asks too", () => {
  test("its one Brain call is read-only", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-readonly-legacy-"));
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });
    const seen: CallBrainOptions[] = [];
    try {
      await runHook({
        rawJson: JSON.stringify(eventWithProj(tmpHome, "readonly-legacy")),
        env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
        brainFn: async (opts: CallBrainOptions) => {
          seen.push(opts);
          return { output: fakeBrainOutput, usage: noopUsage };
        },
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.readOnly).toBe(true);
    expect(seen[0]!.projectSettingsOff).toBe(true);
  });
});

function envelope(): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "result", subtype: "success", is_error: false, result: JSON.stringify(OUTPUT),
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  ]);
}

function capturingSpawn(capture: { argv?: string[] }): typeof Bun.spawn {
  return ((cmd: string[]) => {
    capture.argv = cmd;
    return {
      stdin: { write() {}, end() {} },
      stdout: new Response(envelope()).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

describe("the ask reaches claude's argv through the production chain", () => {
  async function argvFor(readOnly: boolean | undefined): Promise<string[]> {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-readonly-argv-"));
    const capture: { argv?: string[] } = {};
    try {
      const call = makeGuardedCallBrain({ homeBase: home, provider: makeClaudeProvider(), checkBudgetFn: async () => true });
      await call({ systemPrompt: "sp", contextBundle: "cb", spawnFn: capturingSpawn(capture), ...(readOnly === undefined ? {} : { readOnly }) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    return capture.argv ?? [];
  }

  test("read-only: only Read, Grep and Glob, and no MCP servers", async () => {
    const argv = await argvFor(true);
    expect(argv.slice(-3)).toEqual(["--tools", "Read,Grep,Glob", "--strict-mcp-config"]);
    // `--tools` takes several values: nothing may follow it but the list and a flag.
    expect(argv.filter((a) => a === "--tools")).toHaveLength(1);
  });

  test("a call that does not ask keeps every tool", async () => {
    for (const readOnly of [undefined, false]) {
      const argv = await argvFor(readOnly);
      expect(argv).not.toContain("--tools");
      expect(argv).not.toContain("--strict-mcp-config");
      expect(argv.at(-1)).toBe("--no-session-persistence");
    }
  });
});
