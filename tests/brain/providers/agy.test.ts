// Agy adapter (track #7 T2) — fake spawnFn only, NEVER spawns the real agy
// binary. Spike findings (Task 1, committed 5e1b0227) that BIND this test:
// --sandbox is non-negotiable-always, SILTPOKE_INTERNAL=1 recursion guard,
// cwd (not -C) reaches Bun.spawn. See:
// an internal design note Task 2.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainError } from "../../../src/brain/brain";
import { parseBrainOutput } from "../../../src/brain/schema";
import {
  makeAgyProvider,
  mergeAgyPrompt,
  AGY_PROMPT_MAX_BYTES,
} from "../../../src/brain/providers/agy";

// Task 8 wired a best-effort conversation-DB reaper into call() that runs on
// EVERY call (success or failure): recordAgyConversation reads OUR per-call
// --log-file (a temp path under os.tmpdir(), harmless), but
// reapAgyConversations with no args resolves its defaults to the REAL
// `<ANTIGRAVITY_HOME>/conversations/` and `<SILTPOKE_HOME>/agy-reviewer-
// conversations.json`. Every test below calls makeAgyProvider().call() with a
// fake spawnFn, so this suite never spawns real agy — but without sandboxing
// those two homes, the reaper's fs reads/writes would still touch the REAL
// `~/.gemini/` and `~/.siltpoke/` on the machine running the suite. Point both
// homes at a throwaway temp dir for the whole file so this suite is fully
// hermetic. (The reap is a no-op here — the sandbox registry is empty — but
// the env override guarantees it can never reach the real trees.)
let sandboxHome: string;
let prevAntigravityHome: string | undefined;
let prevSiltpokeHome: string | undefined;

beforeAll(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), "agy-test-sandbox-"));
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

// Real Task-1 spike fixture — a live-captured `agy -p` reply, bare clean
// JSON (no fence). tests/brain/providers/agy.test.ts → "../../fixtures/agy"
// resolves to tests/fixtures/agy/.
const FIXTURE_REPLY = readFileSync(
  join(import.meta.dir, "../../fixtures/agy/brain-reply.json"),
  "utf8",
);

// A minimal brainOutputSchema-conformant reply — Task 4 fills the real
// fence-strip + fixture-driven parsing; this stub JSON only needs to survive
// the Task 2 stub call() so argv/env/cwd assertions can run post-call.
const HAPPY_JSON = JSON.stringify({
  mood: "happy",
  pose: "base",
  bubble_short: "looks good",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
});

interface FakeProc {
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
    stdout: new Response(opts.stdoutText).body,
    stderr: new Response(opts.stderrText ?? "").body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

// ── 1. meta ──────────────────────────────────────────────────────────────

test("agy provider meta matches spec (quota billing, google gen_ai.system)", () => {
  const provider = makeAgyProvider();
  expect(provider.meta).toEqual({
    name: "agy",
    billing: "quota",
    genAiSystem: "google",
  });
});

// ── 2. argv shape ────────────────────────────────────────────────────────

test("spawnAgy argv: -p <prompt> --model <model> --print-timeout <n> --sandbox --log-file <path>, in that order", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await makeAgyProvider().call({
    systemPrompt: "You are Siltpoke reviewing a diff.",
    contextBundle: "diff --git a/x.ts",
    model: "gemini-3-pro",
    spawnFn,
  });

  // argv[0] is the binary name (Bun.spawn execs it) — WITHOUT it spawn tried
  // to exec "-p" (blind-ship bug from #247, caught by the #17 live smoke).
  expect(seenArgv[0]).toBe("agy");
  expect(seenArgv[1]).toBe("-p");
  // prompt rides argv[2] — NOT stdin (spike: agy has no stdin path).
  expect(seenArgv[2]).toContain("You are Siltpoke reviewing a diff.");
  expect(seenArgv[2]).toContain("diff --git a/x.ts");
  expect(seenArgv[3]).toBe("--model");
  expect(seenArgv[4]).toBe("gemini-3-pro");
  expect(seenArgv[5]).toBe("--print-timeout");
  expect(typeof seenArgv[6]).toBe("string");
  expect(seenArgv[6]!.length).toBeGreaterThan(0);
  expect(seenArgv[7]).toBe("--sandbox");
  // Task 8 fix: per-call --log-file for race-free conversation attribution.
  expect(seenArgv[8]).toBe("--log-file");
  expect(typeof seenArgv[9]).toBe("string");
  expect(seenArgv[9]!.length).toBeGreaterThan(0);
  expect(seenArgv).toHaveLength(10);
});

test("--model omitted from argv entirely when opts.model is unset (agy uses its own default)", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await makeAgyProvider().call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn,
  });

  expect(seenArgv).not.toContain("--model");
  expect(seenArgv[0]).toBe("agy");
  expect(seenArgv[1]).toBe("-p");
  expect(seenArgv[3]).toBe("--print-timeout");
  expect(seenArgv[5]).toBe("--sandbox");
  expect(seenArgv).toContain("--sandbox");
});

// ── 3. --sandbox is hardcoded-always (spike T1 binding constraint) ───────

test("--sandbox is present even when caller supplies no options beyond the required ones", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", spawnFn });

  // --sandbox is never conditional / never a caller option — hardcoded always.
  expect(seenArgv).toContain("--sandbox");
});

// ── 4. recursion guard + cwd (spike T1 binding constraints) ──────────────

test("spawn env carries SILTPOKE_INTERNAL=1 (recursion guard vs agy's own Stop hook)", async () => {
  let seenOptions: Record<string, unknown> = {};
  const spawnFn = ((_cmd: string[], options: unknown) => {
    seenOptions = options as Record<string, unknown>;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", spawnFn });

  const env = seenOptions.env as Record<string, string>;
  expect(env.SILTPOKE_INTERNAL).toBe("1");
});

test("spawn cwd === opts.cwd (agy has no -C flag; it uses process cwd, so Bun.spawn's cwd must carry the reviewed repo)", async () => {
  let seenOptions: Record<string, unknown> = {};
  const spawnFn = ((_cmd: string[], options: unknown) => {
    seenOptions = options as Record<string, unknown>;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  const reviewedRepo = "/some/other/repo/not-the-daemon-cwd";
  await makeAgyProvider().call({
    systemPrompt: "s",
    contextBundle: "c",
    cwd: reviewedRepo,
    spawnFn,
  });

  expect(seenOptions.cwd).toBe(reviewedRepo);
  expect(seenOptions.cwd).not.toBe(process.cwd());
});

test("spawn cwd falls back to process.cwd() when opts.cwd is omitted/empty (manual/direct-call compat)", async () => {
  let seenOptions: Record<string, unknown> = {};
  const spawnFn = ((_cmd: string[], options: unknown) => {
    seenOptions = options as Record<string, unknown>;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await makeAgyProvider().call({ systemPrompt: "s", contextBundle: "c", cwd: "", spawnFn });

  expect(seenOptions.cwd).toBe(process.cwd());
});

// ── 5. kill-timer (mirror codex.test.ts's kill-timer assertion) ─────────

test("external kill-timer fires at timeoutMs and calls proc.kill()", async () => {
  let killed = false;
  let resolveExit: (code: number) => void;
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const spawnFn = ((_cmd: string[], _options: unknown) => ({
    stdout: new Response("").body,
    stderr: new Response("").body,
    exited: exitedPromise,
    kill() {
      killed = true;
      resolveExit(143);
    },
  })) as unknown as typeof Bun.spawn;

  await expect(
    makeAgyProvider().call({
      systemPrompt: "s",
      contextBundle: "c",
      timeoutMs: 20,
      spawnFn,
    }),
  ).rejects.toBeInstanceOf(BrainError);

  expect(killed).toBe(true);
});

// ── 6. Task 4 — response parsing: exit-code gate + fence-strip + zod +
// usage/servedModel. Driven by the REAL Task-1 spike fixture, not
// synthesized JSON. ────────────────────────────────────────────────────────

test("call(): exit 0 + real fixture stdout → valid BrainCallResult (parseBrainOutput-conformant, quota usage, servedModel echoes opts.model)", async () => {
  const result = await makeAgyProvider().call({
    systemPrompt: "s",
    contextBundle: "c",
    model: "gemini-3-pro",
    spawnFn: fakeSpawn({ stdoutText: FIXTURE_REPLY }),
  });

  // The provider's own parse must have produced output that ALSO
  // independently passes parseBrainOutput — proves the fixture round-trips
  // through the real schema, not just a hand-picked subset of fields.
  expect(() => parseBrainOutput(result.output)).not.toThrow();
  expect(result.output.mood).toBe("happy");
  expect(result.output.bubble_short).toBe("Math is finally mathing!");
  expect(result.output.evidence).toHaveLength(1);

  expect(result.usage).toEqual({
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: null,
  });
  expect(result.usage.total_cost_usd).toBeNull();

  // Configured-not-attested: agy prints no run banner, so servedModel is
  // whatever opts.model was configured with — never independently verified.
  expect(result.servedModel).toBe("gemini-3-pro");
});

test("call(): exit 2 → BrainError classified as a flag/usage error, text captured from STDERR (Task 1 spike: exit-2 error text lands on stderr, not stdout)", async () => {
  let caught: unknown;
  try {
    await makeAgyProvider().call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({
        stdoutText: "",
        stderrText: "flag provided but not defined: -this-flag-does-not-exist",
        exitCode: 2,
      }),
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(BrainError);
  const err = caught as BrainError;
  expect(err.failure?.exitCode).toBe(2);
  expect(err.failure?.stderr).toContain("flag provided but not defined");
  // Message classifies exit 2 distinctly from a generic runtime failure —
  // never trust stdout content over the exit code either way.
  expect(err.message).toMatch(/flag\/usage error/i);
  expect(err.message).toContain("flag provided but not defined");
  // No `failure`-less shortcut: this is a subprocess exit failure, so the
  // structured failure field IS populated (unlike parse/schema BrainErrors).
  expect(err.failure).toBeDefined();
});

test("call(): exit 1 → BrainError classified as an (unclassified, defensive) runtime error, text captured from STDOUT", async () => {
  let caught: unknown;
  try {
    await makeAgyProvider().call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({ stdoutText: "Error: something broke", exitCode: 1 }),
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BrainError);
  const err = caught as BrainError;
  expect(err.failure?.exitCode).toBe(1);
  expect(err.message).toMatch(/runtime error/i);
  expect(err.message).toContain("Error: something broke");
});

test("call(): exit 0 but unparseable stdout → BrainError (parse failure), never trusts content just because the exit code was 0", async () => {
  let caught: unknown;
  try {
    await makeAgyProvider().call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({ stdoutText: "not json at all, just prose", exitCode: 0 }),
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BrainError);
  // Parse/schema failures are NOT subprocess failures — `failure` stays
  // undefined here (Task 2's convention, mirrored from claude.ts/codex.ts).
  expect((caught as BrainError).failure).toBeUndefined();
  // Pinning test (single-brain S2 fix): the review path must be
  // byte-identical to the pre-callRaw adapter — the agy-tagged message, NOT
  // the shared brainOutputFromText generic ("Brain response was not valid
  // JSON..."). A regression back to the generic message must fail this.
  expect((caught as Error).message).toBe(
    "agy -p produced no parseable JSON on stdout",
  );
});

test("call(): exit 0 but stdout parses to JSON that fails brainOutputSchema → BrainError (schema failure), not a parse failure", async () => {
  let caught: unknown;
  try {
    await makeAgyProvider().call({
      systemPrompt: "s",
      contextBundle: "c",
      spawnFn: fakeSpawn({
        stdoutText: JSON.stringify({ mood: "not-a-real-mood", pose: "base" }),
        exitCode: 0,
      }),
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BrainError);
  expect((caught as BrainError).failure).toBeUndefined();
  // Pinning test (single-brain S2 fix): agy-tagged, not the shared
  // brainOutputFromText generic ("Brain response failed schema validation").
  expect((caught as Error).message).toBe("agy response failed schema validation");
});

test("call(): fence-wrapped JSON (```json ... ```) still parses — DEFENSIVE fallback (spike's fixture is bare, but a heavier model may fence)", async () => {
  const fenced = "```json\n" + HAPPY_JSON + "\n```";
  const result = await makeAgyProvider().call({
    systemPrompt: "s",
    contextBundle: "c",
    spawnFn: fakeSpawn({ stdoutText: fenced }),
  });

  expect(result.output.mood).toBe("happy");
  expect(result.output.bubble_short).toBe("looks good");
});

// ── 7. mergeAgyPrompt (Task 3) — agy has no system-prompt flag, so the
// rubric + context must ride ONE argv string with a clear delimiter ────────

test("mergeAgyPrompt: joins system + context with a delimiter, system ordered before context", () => {
  const merged = mergeAgyPrompt(
    "RUBRIC: you are Siltpoke's reviewer.",
    "diff --git a/x.ts b/x.ts",
  );

  expect(merged).toContain("RUBRIC: you are Siltpoke's reviewer.");
  expect(merged).toContain("diff --git a/x.ts b/x.ts");
  // The rubric must be distinguishable from the context, not just concatenated
  // blind — assert an explicit section marker exists for each half.
  expect(merged).toMatch(/SYSTEM/i);
  expect(merged).toMatch(/CONTEXT/i);
  expect(merged.indexOf("RUBRIC: you are Siltpoke's reviewer.")).toBeLessThan(
    merged.indexOf("diff --git a/x.ts b/x.ts"),
  );
});

test("mergeAgyPrompt: system and context sections stay distinguishable even when context contains the word 'system'", () => {
  const merged = mergeAgyPrompt("sys-prompt-marker", "context mentions system twice: system");
  // Both markers still literally present + still findable in order — a naive
  // reader can split on the section headers rather than guessing.
  const systemHeaderIdx = merged.search(/SYSTEM/i);
  const contextHeaderIdx = merged.search(/CONTEXT/i);
  expect(systemHeaderIdx).toBeGreaterThanOrEqual(0);
  expect(contextHeaderIdx).toBeGreaterThan(systemHeaderIdx);
});

// ── 8. argv size gate (Task 3) — abstain over cap, NEVER truncate ────────

test("AGY_PROMPT_MAX_BYTES constant is exactly 200000 (Task 1 spike finding, defensive headroom)", () => {
  expect(AGY_PROMPT_MAX_BYTES).toBe(200_000);
});

test("call(): merged prompt over AGY_PROMPT_MAX_BYTES rejects with BrainError code agy_prompt_too_large and NEVER invokes spawnFn", async () => {
  let spawnCalled = false;
  const spawnFn = ((_cmd: string[], _options: unknown) => {
    spawnCalled = true;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  // Multi-byte UTF-8 filler (each  is 3 bytes) — asserts the gate checks
  // Buffer.byteLength, not JS string .length (char count would under-count
  // and let an over-cap prompt slip through the gate).
  const filler = "锅".repeat(Math.ceil(AGY_PROMPT_MAX_BYTES / 3) + 10);

  let caught: unknown;
  try {
    await makeAgyProvider().call({
      systemPrompt: "s",
      contextBundle: filler,
      spawnFn,
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(BrainError);
  expect((caught as BrainError).code).toBe("agy_prompt_too_large");
  expect(spawnCalled).toBe(false);
});

test("call(): merged prompt under AGY_PROMPT_MAX_BYTES proceeds to spawn with the merged prompt as argv[2]", async () => {
  let seenArgv: string[] = [];
  const spawnFn = ((cmd: string[], _options: unknown) => {
    seenArgv = cmd;
    return {
      stdout: new Response(HAPPY_JSON).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;

  await makeAgyProvider().call({
    systemPrompt: "RUBRIC-MARKER",
    contextBundle: "CONTEXT-MARKER",
    spawnFn,
  });

  expect(seenArgv[0]).toBe("agy");
  expect(seenArgv[1]).toBe("-p");
  expect(seenArgv[2]).toContain("RUBRIC-MARKER");
  expect(seenArgv[2]).toContain("CONTEXT-MARKER");
  expect(seenArgv[2]).toBe(mergeAgyPrompt("RUBRIC-MARKER", "CONTEXT-MARKER"));
});
