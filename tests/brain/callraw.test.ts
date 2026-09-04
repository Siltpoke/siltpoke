import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeProvider } from "../../src/brain/provider";
import { makeCodexProvider } from "../../src/brain/providers/codex";
import { makeQoderProvider } from "../../src/brain/providers/ccfork-reviewer";
import { makeAgyProvider } from "../../src/brain/providers/agy";

// Minimal fake of `claude -p --output-format json`: emits a JSON array whose
// last event is a `result` carrying the given inner text. Mirrors the shape
// runBrainCall() parses (brain.ts:116-238).
function fakeClaudeSpawn(innerResult: string, capture?: { systemPrompt?: string }) {
  return ((argv: string[]) => {
    const spIdx = argv.indexOf("--system-prompt");
    if (capture && spIdx >= 0) capture.systemPrompt = argv[spIdx + 1];
    const events = [{ type: "result", result: innerResult, total_cost_usd: 0, usage: {} }];
    return {
      stdin: { write() {}, end() {} },
      stdout: new Response(JSON.stringify(events)).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

describe("claude provider callRaw", () => {
  test("returns raw text + servedModel (default model when unset)", async () => {
    const p = makeClaudeProvider();
    const r = await p.callRaw({ systemPrompt: "sp", contextBundle: "ctx", spawnFn: fakeClaudeSpawn("hello raw") });
    expect(r.text).toBe("hello raw");
    expect(r.servedModel).toBe("claude-haiku-4-5");
  });

  test("callRaw passes systemPrompt VERBATIM — no persona appended (spec §6)", async () => {
    const p = makeClaudeProvider();
    const cap: { systemPrompt?: string } = {};
    await p.callRaw({ systemPrompt: "BARE TASK PROMPT", contextBundle: "c", spawnFn: fakeClaudeSpawn("{}", cap) });
    expect(cap.systemPrompt).toBe("BARE TASK PROMPT");
  });

  test("call() still parses the brain envelope (layered on callRaw, byte-identical)", async () => {
    const p = makeClaudeProvider();
    const envelope = JSON.stringify({
      mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "l",
      critique_for_claude: "", severity: "info", confidence: "medium", xp_earned_events: [],
    });
    const r = await p.call({ systemPrompt: "sp", contextBundle: "ctx", spawnFn: fakeClaudeSpawn(envelope) });
    expect(r.output.mood).toBe("happy");
    expect(r.servedModel).toBe("claude-haiku-4-5");
  });
});

// Minimal fake of `codex exec --json`: a JSONL stream whose last
// item.completed agent_message carries the given raw text, plus a
// turn.completed usage event. Mirrors the shape runCodexCall() parses
// (tests/brain/providers/codex.test.ts's fakeSpawn).
function fakeCodexSpawn(agentText: string) {
  const jsonl = [
    JSON.stringify({
      type: "item.completed",
      item: { id: "i", type: "agent_message", text: agentText },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
    }),
  ].join("\n");
  return ((_cmd: string[], _options: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response(jsonl).body,
    stderr: new Response("model: gpt-5.5\n").body,
    exited: Promise.resolve(0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

describe("codex provider callRaw", () => {
  test("codex callRaw returns the agent message text + servedModel", async () => {
    const p = makeCodexProvider();
    const r = await p.callRaw({
      systemPrompt: "sp",
      contextBundle: "c",
      model: "gpt-x",
      spawnFn: fakeCodexSpawn("raw-codex"),
    });
    expect(r.text).toContain("raw-codex");
    expect(r.servedModel).toBeDefined();
  });
});

// Minimal fake of `qodercli -p --output-format json`: a single claude-shaped
// envelope wrapping the given inner result text. Mirrors the `envelope()`
// helper in tests/brain/providers/ccfork-reviewer.test.ts.
function fakeQoderSpawn(innerResult: string) {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: innerResult,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    session_id: "s",
  });
  return ((_cmd: string[], _options: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

describe("qoder provider callRaw", () => {
  // The qoder callRaw path wires a best-effort session reaper into its
  // `finally` (recordQoderSession writes SILTPOKE_HOME's registry;
  // reapQoderSessions scans QODER_HOME's projects/). Sandbox both so this
  // describe stays hermetic and can never touch the real ~/.siltpoke / ~/.qoder
  // (mirrors the agy describe below + tests/brain/providers/agy.test.ts).
  let sandboxHome: string;
  let prevSiltpokeHome: string | undefined;
  let prevQoderHome: string | undefined;

  beforeAll(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "qoder-callraw-test-sandbox-"));
    prevSiltpokeHome = process.env.SILTPOKE_HOME;
    prevQoderHome = process.env.QODER_HOME;
    process.env.SILTPOKE_HOME = join(sandboxHome, "siltpoke-home");
    process.env.QODER_HOME = join(sandboxHome, "qoder-home");
  });

  afterAll(() => {
    if (prevSiltpokeHome === undefined) {
      delete process.env.SILTPOKE_HOME;
    } else {
      process.env.SILTPOKE_HOME = prevSiltpokeHome;
    }
    if (prevQoderHome === undefined) {
      delete process.env.QODER_HOME;
    } else {
      process.env.QODER_HOME = prevQoderHome;
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  test("qoder callRaw returns the envelope's inner result text", async () => {
    const p = makeQoderProvider();
    const r = await p.callRaw({
      systemPrompt: "sp",
      contextBundle: "c",
      spawnFn: fakeQoderSpawn("raw-qoder"),
    });
    expect(r.text).toContain("raw-qoder");
  });
});

// Minimal fake of `agy -p`: emits bare stdout text at the given exit code.
// Mirrors the `fakeSpawn` helper in tests/brain/providers/agy.test.ts.
function fakeAgySpawn(opts: { stdoutText: string; exitCode?: number }): typeof Bun.spawn {
  return ((_cmd: string[], _options: unknown) => ({
    stdout: new Response(opts.stdoutText).body,
    stderr: new Response("").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

describe("agy provider callRaw", () => {
  // Task 8's conversation-DB reaper resolves real ANTIGRAVITY_HOME/
  // SILTPOKE_HOME paths unless overridden — sandbox both for this describe
  // block so the suite stays hermetic (mirrors tests/brain/providers/agy.test.ts).
  let sandboxHome: string;
  let prevAntigravityHome: string | undefined;
  let prevSiltpokeHome: string | undefined;

  beforeAll(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agy-callraw-test-sandbox-"));
    prevAntigravityHome = process.env.ANTIGRAVITY_HOME;
    prevSiltpokeHome = process.env.SILTPOKE_HOME;
    process.env.ANTIGRAVITY_HOME = join(sandboxHome, "gemini-home");
    process.env.SILTPOKE_HOME = join(sandboxHome, "siltpoke-home");
  });

  afterAll(() => {
    if (prevAntigravityHome === undefined) {
      delete process.env.ANTIGRAVITY_HOME;
    } else {
      process.env.ANTIGRAVITY_HOME = prevAntigravityHome;
    }
    if (prevSiltpokeHome === undefined) {
      delete process.env.SILTPOKE_HOME;
    } else {
      process.env.SILTPOKE_HOME = prevSiltpokeHome;
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  test("agy callRaw returns raw stdout as text (usage all-zero)", async () => {
    const p = makeAgyProvider();
    const r = await p.callRaw({
      systemPrompt: "sp",
      contextBundle: "c",
      model: "m",
      spawnFn: fakeAgySpawn({ stdoutText: "raw-agy" }),
    });
    expect(r.text).toContain("raw-agy");
    expect(r.usage.input_tokens).toBe(0);
    expect(r.usage.output_tokens).toBe(0);
    expect(r.usage.total_cost_usd).toBeNull();
    expect(r.servedModel).toBe("m");
  });

  test("agy callRaw still honors the pre-spawn too-large abstain gate", async () => {
    const p = makeAgyProvider();
    let spawnCalled = false;
    const spawnFn = ((_cmd: string[], _options: unknown) => {
      spawnCalled = true;
      return {
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as unknown as typeof Bun.spawn;
    // Multi-byte filler so the gate's Buffer.byteLength check trips well
    // past AGY_PROMPT_MAX_BYTES (200_000) regardless of char-vs-byte counting.
    const huge = "x".repeat(10_000_000);

    let caught: unknown;
    try {
      await p.callRaw({ systemPrompt: "sp", contextBundle: huge, spawnFn });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("agy_prompt_too_large");
    expect(spawnCalled).toBe(false);
  });
});
