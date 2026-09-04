/**
 * The reviewer's kill timer must be reachable without editing code.
 *
 * `DEFAULT_TIMEOUT_MS` is 90s and 453 critic calls — 14.2% of all of them —
 * end at 89-92s, killed by it. `brain.ts` already reads
 * `SILTPOKE_BRAIN_TIMEOUT_MS`, but the Stop hook is spawned by the host and
 * does not inherit a shell's environment, so in practice nothing could move
 * that number. These tests pin the config route end to end, because the whole
 * point is to answer "how long would a killed call have needed" by running with
 * a higher cap — and a knob that does not reach the call site would answer
 * nothing while looking like it had.
 *
 * The assertion is on what `callBrainFn` actually receives, not on the loader's
 * return value: `run-critic.ts` resolving a number is not the same claim as the
 * subprocess being spawned with it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainCallResult, CallBrainOptions } from "../../src/brain/brain";
import { loadBrainTimeoutMs } from "../../src/config/brain-timeout-config";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { runCritic } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

function caps(): ProjectCapabilities {
  return {
    cwd: "/tmp/test", hasGit: true, hasTsc: false, hasEslint: false,
    hasRipgrep: false, tsconfigPaths: [], eslintConfigPaths: [],
    detectedAt: Date.now(), configMtimes: {},
  };
}

function na(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc": return { tool: "tsc", status: "not_applicable", parsed: [], raw: "" };
    case "eslint": return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
    case "git-diff": return { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" };
    case "ripgrep": return { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" };
  }
}

const OUTPUT = {
  mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
  critique_for_claude: "", severity: "info", confidence: "medium",
  xp_earned_events: [], evidence: [],
} as const;

/** Run one turn against a stubbed Brain and report the timeoutMs it was given. */
async function timeoutSeenByBrain(home: string): Promise<number | undefined> {
  let seen: number | undefined;
  await runCritic(
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
        "git-diff": { tool: "git-diff", status: "ok", parsed: [{ file: "src/foo.ts", header: "@@", body: "+const x = 1;" }], raw: "" } as ToolResult,
        ripgrep: na("ripgrep"),
        securityFindings: [], owaspHints: [], webSearchSources: [],
      }),
      callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
        seen = opts.timeoutMs;
        return { output: OUTPUT as never, usage: { input_tokens: 1, output_tokens: 1 } as never };
      },
      writeCritiqueFn: async () => ({ id: "c-test", path: "/tmp/c-test.md" }),
    },
  );
  return seen;
}

describe("brain timeout from config.json", () => {
  function withHome(config: unknown | null): string {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-timeout-"));
    mkdirSync(join(home, "state"), { recursive: true });
    if (config !== null) {
      writeFileSync(join(home, "config.json"), JSON.stringify(config));
    }
    return home;
  }

  test("a configured timeout reaches the Brain call", async () => {
    const home = withHome({ brain: { timeout_ms: 180_000 } });
    try {
      expect(await timeoutSeenByBrain(home)).toBe(180_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no config key → nothing forced, so env and the default still decide", async () => {
    const home = withHome({ quietHours: { start: "00:00", end: "00:00" } });
    try {
      // `undefined` is the meaningful value here, not a missing assertion:
      // resolveBrainTimeoutMs only consults the env var when the explicit
      // argument is absent, so forcing 90_000 here would silently disable it.
      expect(await timeoutSeenByBrain(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an out-of-range value is ignored rather than obeyed or thrown", async () => {
    const home = withHome({ brain: { timeout_ms: 5_000_000 } });
    try {
      expect(await timeoutSeenByBrain(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a malformed config does not take the reviewer down", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-timeout-"));
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "config.json"), "{ not json at all");
    try {
      expect(await timeoutSeenByBrain(home)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("loadBrainTimeoutMs", () => {
  function home(config: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-cfg-"));
    if (config !== null) writeFileSync(join(dir, "config.json"), config);
    return dir;
  }

  test("reads the value", async () => {
    const d = home('{"brain":{"timeout_ms":123000}}');
    expect(await loadBrainTimeoutMs(d)).toBe(123_000);
    rmSync(d, { recursive: true, force: true });
  });

  test("missing file, missing key, wrong type and out-of-range all give undefined", async () => {
    const missing = mkdtempSync(join(tmpdir(), "siltpoke-cfg-"));
    expect(await loadBrainTimeoutMs(missing)).toBeUndefined();
    rmSync(missing, { recursive: true, force: true });

    for (const bad of ['{}', '{"brain":{}}', '{"brain":{"timeout_ms":"180000"}}',
                       '{"brain":{"timeout_ms":500}}', '{"brain":{"timeout_ms":90000.5}}']) {
      const d = home(bad);
      expect(await loadBrainTimeoutMs(d)).toBeUndefined();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
