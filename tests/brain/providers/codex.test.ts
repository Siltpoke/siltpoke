// Codex adapter (track #7 T2) — fake spawnFn replays real live-probe JSONL
// shapes (fixtures under tests/brain/fixtures/codex/, provenance comments
// inside each fixture file). See spec §2 + Revision pass items 1-3:
// an internal design note
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../../src/brain/brain";
import { classifyBrainFailure } from "../../../src/brain/failure-classify";
import { makeCodexProvider } from "../../../src/brain/providers/codex";
import { z } from "zod";
import { brainOutputSchema } from "../../../src/brain/schema";

const FIXTURES = join(import.meta.dir, "../fixtures/codex");
// Hermetic default: a home dir with NO .codex/config.toml, so tests never
// read the machine's real ~/.codex (servedModel fallback stays inert).
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "codex-test-home-"));
const hermetic = () => makeCodexProvider({ configHome: EMPTY_HOME });
const happyJsonl = readFileSync(join(FIXTURES, "happy.jsonl"), "utf8");
const happyStderr = readFileSync(join(FIXTURES, "happy.stderr"), "utf8");
const happyReasoningJsonl = readFileSync(
  join(FIXTURES, "happy-reasoning.jsonl"),
  "utf8",
);
const schemaViolatingJsonl = readFileSync(
  join(FIXTURES, "schema-violating.jsonl"),
  "utf8",
);
const turnFailedJsonl = readFileSync(
  join(FIXTURES, "turn-failed.jsonl"),
  "utf8",
);
const turnFailedStderr = readFileSync(
  join(FIXTURES, "turn-failed.stderr"),
  "utf8",
);

interface FakeProc {
  stdin: { write(chunk: string): void; end(): void };
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  exited: Promise<number>;
  kill(): void;
}

function fakeSpawn(opts: {
  stdoutText: string;
  stderrText?: string;
  exitCode?: number;
}): typeof Bun.spawn {
  return ((_cmd: string[], _options: unknown) => ({
    stdin: {
      write(_chunk: string) {},
      end() {},
    },
    stdout: new Response(opts.stdoutText).body,
    stderr: new Response(opts.stderrText ?? "").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

// ── 1. meta ──────────────────────────────────────────────────────────────

test("codex provider meta matches spec §1 (quota billing, openai gen_ai.system)", () => {
  const provider = hermetic();
  expect(provider.meta).toEqual({
    name: "codex",
    billing: "quota",
    genAiSystem: "openai",
  });
});

// ── 2. happy path ────────────────────────────────────────────────────────

test("happy path: valid BrainOutput; real --json stderr is EMPTY -> servedModel falls back (undefined w/ no config)", async () => {
  const provider = hermetic();
  const { output, usage, servedModel } = await provider.call({
    systemPrompt: "s",
    contextBundle: "c",
    // Live-verified 2026-07-07: --json suppresses the stderr banner entirely.
    spawnFn: fakeSpawn({ stdoutText: happyJsonl, stderrText: "" }),
  });

  expect(output.mood).toBe("happy");
  expect(output.bubble_short).toBe("looks good");
  expect(servedModel).toBeUndefined();
  // usage normalization arithmetic asserted in full below (test 3).
  expect(usage.total_cost_usd).toBeNull();
});

test("servedModel priority: stderr banner wins when present (future-proof opportunistic parse)", async () => {
  const { servedModel } = await hermetic().call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: happyJsonl, stderrText: happyStderr }),
  });
  expect(servedModel).toBe("gpt-5.5");
});

test("servedModel fallback: ~/.codex/config.toml model key (the practical production source)", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-test-cfg-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n',
  );

  const { servedModel } = await makeCodexProvider({ configHome: home }).call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: happyJsonl, stderrText: "" }),
  });
  expect(servedModel).toBe("gpt-5.5");
});

// ── 3. usage normalization arithmetic (AC6) ─────────────────────────────

test("usage normalization: input_tokens excludes cached, cache_read = cached, cache_creation = 0", async () => {
  const provider = hermetic();
  const { usage } = await provider.call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: happyJsonl }),
  });

  // run3.jsonl ground truth: input_tokens:15006, cached_input_tokens:4992
  expect(usage.input_tokens).toBe(15006 - 4992);
  expect(usage.cache_read_input_tokens).toBe(4992);
  expect(usage.cache_creation_input_tokens).toBe(0);
  expect(usage.output_tokens).toBe(13);
  expect(usage.total_cost_usd).toBeNull();
});

test("output_tokens is used AS-IS (inclusive of reasoning — live-verified fixture w/ reasoning 56)", async () => {
  const { usage } = await hermetic().call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: happyReasoningJsonl }),
  });
  // probe ground truth: output 63 = reasoning 56 + ~7 visible ("18").
  expect(usage.output_tokens).toBe(63);
  expect(usage.input_tokens).toBe(14522 - 2432);
});

test("normalization clamps: cached > input_total never yields a negative input_tokens", async () => {
  const jsonl = [
    '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\"mood\\":\\"happy\\",\\"pose\\":\\"base\\",\\"bubble_short\\":\\"ok\\",\\"bubble_long\\":\\"\\",\\"critique_for_claude\\":\\"\\",\\"severity\\":\\"info\\",\\"confidence\\":\\"high\\",\\"xp_earned_events\\":[]}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":150,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join("\n");

  const { usage } = await hermetic().call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: jsonl }),
  });
  expect(usage.input_tokens).toBe(0);
});

test("argv shape survives a realistic multi-line system prompt (single -c element, no -m)", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(happyJsonl).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  const multiLinePrompt = ["You are Siltpoke.", "", "## Rules", "- be honest", "- cite evidence"].join("\n");
  await hermetic().call({
    systemPrompt: multiLinePrompt,
    contextBundle: "c",
    spawnFn,
  });

  expect(seenArgv[0]).toBe("codex");
  expect(seenArgv[1]).toBe("exec");
  expect(seenArgv).toContain("--json");
  expect(seenArgv).toContain("--ephemeral");
  expect(seenArgv).toContain("--skip-git-repo-check");
  expect(seenArgv[seenArgv.indexOf("-s") + 1]).toBe("read-only");
  // whole multi-line prompt rides ONE argv element after -c
  const cIdx = seenArgv.indexOf("-c");
  expect(seenArgv[cIdx + 1]).toBe(`developer_instructions=${multiLinePrompt}`);
  expect(seenArgv[seenArgv.indexOf("--output-schema") + 1]).toMatch(/\.json$/);
  expect(seenArgv[seenArgv.length - 1]).toBe("-");
  expect(seenArgv).not.toContain("-m");
});

// Track #7 T3 deferred item: the daemon's own process.cwd() is frozen at
// launch time and is NOT the repo under review — the reviewed-repo cwd must
// reach codex's `-C` flag, not the daemon's cwd.
test("reviewed-repo cwd (opts.cwd) reaches argv -C, not process.cwd()", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(happyJsonl).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  const reviewedRepo = "/some/other/repo/not-the-daemon-cwd";
  await hermetic().call({
    systemPrompt: "sp",
    contextBundle: "c",
    cwd: reviewedRepo,
    spawnFn,
  });

  expect(seenArgv[seenArgv.indexOf("-C") + 1]).toBe(reviewedRepo);
  expect(seenArgv[seenArgv.indexOf("-C") + 1]).not.toBe(process.cwd());
});

test("cwd omitted falls back to process.cwd() (manual/direct-call compat)", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(happyJsonl).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await hermetic().call({ systemPrompt: "sp", contextBundle: "c", spawnFn });

  expect(seenArgv[seenArgv.indexOf("-C") + 1]).toBe(process.cwd());
});

test('cwd: "" (hook payload without cwd -> brainContext default) also falls back, never spawns -C ""', async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(happyJsonl).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await hermetic().call({ systemPrompt: "sp", contextBundle: "c", cwd: "", spawnFn });

  expect(seenArgv[seenArgv.indexOf("-C") + 1]).toBe(process.cwd());
});

// ── 4. missing usage -> zeros (contingency) ─────────────────────────────

test("missing turn.completed.usage normalizes to zeros + null cost, never fabricated", async () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"mood\\":\\"happy\\",\\"pose\\":\\"base\\",\\"bubble_short\\":\\"ok\\",\\"bubble_long\\":\\"\\",\\"critique_for_claude\\":\\"\\",\\"severity\\":\\"info\\",\\"confidence\\":\\"high\\",\\"xp_earned_events\\":[]}"}}',
    '{"type":"turn.completed"}',
  ].join("\n");

  const provider = hermetic();
  const { usage } = await provider.call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: jsonl }),
  });

  expect(usage).toEqual({
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: null,
  });
});

// ── 5. unknown event types ignored ──────────────────────────────────────

test("unknown event types are ignored, not fatal (happy.jsonl's own provenance line IS one)", async () => {
  const provider = hermetic();
  // happyJsonl's first line is {"type":"_fixture_provenance",...} — an
  // unrecognized type that must not crash the parse.
  await expect(
    provider.call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({ stdoutText: happyJsonl }),
    }),
  ).resolves.toBeDefined();
});

// ── 6. schema-violating agent_message -> BrainError (parse path, AC3) ───

test("schema-violating agent_message throws BrainError via the same parseBrainOutput gate as claude", async () => {
  const provider = hermetic();
  await expect(
    provider.call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({ stdoutText: schemaViolatingJsonl }),
    }),
  ).rejects.toBeInstanceOf(BrainError);
  await expect(
    provider.call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({ stdoutText: schemaViolatingJsonl }),
    }),
  ).rejects.toThrow(/schema validation/);
});

// ── 7. turn.failed -> BrainError w/ failure -> classifyBrainFailure ─────

test("turn.failed produces BrainError with a populated `failure` that the classifier can consume", async () => {
  const provider = hermetic();
  let caught: unknown;
  try {
    await provider.call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({
        stdoutText: turnFailedJsonl,
        stderrText: turnFailedStderr,
        exitCode: 1,
      }),
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(BrainError);
  const failure = (caught as BrainError).failure;
  expect(failure).toBeDefined();
  expect(failure!.exitCode).toBe(1);
  expect(failure!.stderr).toContain("not supported when using Codex");

  // Real captured 400 "model not supported" text matches none of the
  // permanent/throttle/resource marker sets -> falls to ambiguous (the
  // signed contingency bucket), same posture as claude's empty-tail exit-1
  // majority. Asserting the ACTUAL class per markers, not a wished-for one.
  expect(classifyBrainFailure(failure!)).toBe("ambiguous");
});

// ── 8. exit 1 without turn.failed ───────────────────────────────────────

test("plain nonzero exit without turn.failed still throws BrainError w/ failure", async () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
  ].join("\n");

  let caught: unknown;
  try {
    await hermetic().call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({
        stdoutText: jsonl,
        stderrText: "codex crashed unexpectedly",
        exitCode: 1,
      }),
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(BrainError);
  expect((caught as BrainError).failure?.exitCode).toBe(1);
});

// ── 9. kill-timer fires on a never-resolving process ────────────────────

test("external kill-timer fires at timeoutMs and calls proc.kill()", async () => {
  let killed = false;
  let resolveExit: (code: number) => void;
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const spawnFn = ((_cmd: string[], _options: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response("").body,
    stderr: new Response("").body,
    exited: exitedPromise,
    kill() {
      killed = true;
      resolveExit(143);
    },
  })) as unknown as typeof Bun.spawn;

  await expect(
    hermetic().call({
      systemPrompt: "s",
      contextBundle: "c",
      timeoutMs: 20,
      spawnFn,
    }),
  ).rejects.toBeInstanceOf(BrainError);

  expect(killed).toBe(true);
});

// ── 10. prompt-size pre-spawn assert ─────────────────────────────────────

test("system prompt >= 200_000 chars throws BrainError BEFORE spawning (a $0 failure)", async () => {
  let spawnCalled = false;
  const spawnFn = ((..._args: unknown[]) => {
    spawnCalled = true;
    throw new Error("spawn should never be reached");
  }) as unknown as typeof Bun.spawn;

  const hugePrompt = "x".repeat(200_000);
  await expect(
    hermetic().call({
      systemPrompt: hugePrompt,
      contextBundle: "c",
      spawnFn,
    }),
  ).rejects.toThrow(/system prompt too large/);
  expect(spawnCalled).toBe(false);
});

// ── OpenAI strict schema (live-caught 2026-07-07: 400 invalid_json_schema) ──

test("toOpenAiStrictSchema: every property required; optionals become null-unions", async () => {
  const { toOpenAiStrictSchema } = await import("../../../src/brain/providers/codex");
  const strict = toOpenAiStrictSchema(
    z.toJSONSchema(brainOutputSchema),
  ) as Record<string, unknown>;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      // OpenAI strict rule: required must include EVERY property key.
      expect((obj.required as string[]).sort()).toEqual(
        Object.keys(obj.properties as object).sort(),
      );
    }
    Object.values(obj).forEach(walk);
  };
  walk(strict);
});

test("null-valued strict-schema optionals are stripped before zod (line: null passes)", async () => {
  const withNullLine = JSON.stringify({
    mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
    critique_for_claude: "", severity: "info", confidence: "high",
    xp_earned_events: [],
    evidence: [{ tool: "tsc", file: "a.ts", line: null, snippet: "x".repeat(20) }],
    reasoning: null,
  });
  const jsonl = [
    `{"type":"item.completed","item":{"id":"i","type":"agent_message","text":${JSON.stringify(withNullLine)}}}`,
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join("\n");

  const { output } = await hermetic().call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: jsonl }),
  });
  expect(output.evidence[0]!.line).toBeUndefined();
  expect(output.reasoning).toBeUndefined();
});
