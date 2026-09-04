// CC-fork reviewer factory (Qoder track) — fake spawnFn only, NEVER spawns a
// real CLI. The real qoder spike fixture's OUTER envelope is claude-shaped and
// valid; its INNER result is NON-conformant to brainOutputSchema (wrong pose,
// numeric confidence, missing required fields) — so the raw fixture drives the
// envelope-shape + schema-REJECTION tests, and a synthetic conformant envelope
// drives the happy path. See an internal design note Task 2.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainError, type CallBrainOptions } from "../../../src/brain/brain";
import {
  makeCodeBuddyProvider,
  makeQoderProvider,
  parseCcForkEnvelope,
} from "../../../src/brain/providers/ccfork-reviewer";

const RAW_FIXTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/qoder/brain-reply-raw.json"),
  "utf8",
);

// The qoder callRaw path wires a best-effort session reaper into its `finally`
// (recordQoderSession + reapQoderSessions). Every qoder test below uses a fake
// spawnFn (never a real CLI), but without sandboxing SILTPOKE_HOME + QODER_HOME
// the reaper's fs reads/writes would touch the REAL `~/.siltpoke/` registry and
// scan the REAL `~/.qoder/projects/` tree on the machine running the suite —
// and the raw fixture's `session_id` is a real on-disk id. Point both homes at
// a throwaway temp dir for the whole file so this suite is fully hermetic. (The
// reap is a no-op here — the sandbox registry stays under keepLast — but the
// override guarantees it can never reach the real trees.)
let sandboxHome: string;
let prevSiltpokeHome: string | undefined;
let prevQoderHome: string | undefined;

beforeAll(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), "ccfork-test-sandbox-"));
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

// A valid brainOutputSchema inner reply (matches schema.ts required fields).
const CONFORMANT_INNER = JSON.stringify({
  mood: "happy",
  pose: "base",
  bubble_short: "looks good",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
});

// Wrap an inner reply in a qoder-shaped -o json envelope.
function envelope(innerResult: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: innerResult,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    session_id: "s",
    ...over,
  });
}

interface FakeProc {
  stdin: { write(s: string): void; end(): void };
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  exited: Promise<number>;
  kill(): void;
}

// Records the argv + stdin the provider spawned, and replays canned streams.
function fakeSpawn(canned: {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  captured?: { argv?: string[]; stdin?: string; env?: Record<string, string>; cwd?: string };
}): typeof Bun.spawn {
  return ((cmd: string[], options: unknown) => {
    const opts = options as { env?: Record<string, string>; cwd?: string } | undefined;
    if (canned.captured) {
      canned.captured.argv = cmd;
      canned.captured.env = opts?.env;
      canned.captured.cwd = opts?.cwd;
    }
    const proc: FakeProc = {
      stdin: {
        write: (s: string) => {
          if (canned.captured) canned.captured.stdin = (canned.captured.stdin ?? "") + s;
        },
        end: () => {},
      },
      stdout: new Response(canned.stdout).body,
      stderr: new Response(canned.stderr ?? "").body,
      exited: Promise.resolve(canned.exitCode ?? 0),
      kill: () => {},
    };
    return proc as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

const baseOpts = (over: Partial<CallBrainOptions> = {}): CallBrainOptions => ({
  systemPrompt: "REVIEW RUBRIC",
  contextBundle: "diff under review",
  cwd: "/repo/under/review",
  ...over,
});

test("qoder: argv carries -p, --system-prompt, --output-format json, --tools '', model; context on stdin; SILTPOKE_INTERNAL=1", async () => {
  const captured: { argv?: string[]; stdin?: string; env?: Record<string, string>; cwd?: string } = {};
  const provider = makeQoderProvider();
  await provider.call(
    baseOpts({
      model: "Lite",
      spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER), captured }),
    }),
  );
  expect(captured.argv?.[0]).toBe("qodercli");
  expect(captured.argv).toContain("-p");
  expect(captured.argv).toContain("--system-prompt");
  expect(captured.argv).toContain("REVIEW RUBRIC");
  expect(captured.argv).toContain("--output-format");
  expect(captured.argv).toContain("json");
  expect(captured.argv).toContain("--tools");
  // The value immediately after --tools MUST be the empty string — that's
  // the load-bearing read-only posture. A regression to e.g. "default"
  // would silently re-enable all tools while still passing a mere
  // toContain("--tools") check.
  const toolsIdx = captured.argv!.indexOf("--tools");
  expect(captured.argv![toolsIdx + 1]).toBe("");
  expect(captured.argv).toContain("--model");
  expect(captured.argv).toContain("Lite");
  expect(captured.stdin).toBe("diff under review");
  expect(captured.env?.SILTPOKE_INTERNAL).toBe("1");
  expect(captured.cwd).toBe("/repo/under/review");
});

test("qoder: --model omitted when no model configured (avoids invalid 'default')", async () => {
  const captured: { argv?: string[] } = {};
  await makeQoderProvider().call(
    baseOpts({ spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER), captured }) }),
  );
  expect(captured.argv).not.toContain("--model");
});

test("qoder: happy path parses a conformant envelope, quota usage (cost null), servedModel = configured", async () => {
  const result = await makeQoderProvider().call(
    baseOpts({ model: "Lite", spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER) }) }),
  );
  expect(result.output.mood).toBe("happy");
  expect(result.usage.total_cost_usd).toBeNull();
  expect(result.usage.input_tokens).toBe(0);
  expect(result.servedModel).toBe("Lite");
});

test("qoder: REAL fixture envelope is claude-shaped but its inner reply fails the schema gate", async () => {
  // The real model reply misses required fields — the zod gate MUST reject it.
  const call = makeQoderProvider().call(
    baseOpts({ spawnFn: fakeSpawn({ stdout: RAW_FIXTURE }) }),
  );
  await expect(call).rejects.toThrow(BrainError);
  // Pinning test (single-brain S2 fix): the review path must be
  // byte-identical to the pre-callRaw adapter — the `${config.name}`-tagged
  // message, NOT the shared brainOutputFromText generic ("Brain response
  // failed schema validation"). A regression back to the generic message
  // must fail this.
  await expect(call).rejects.toThrow("qoder response failed schema validation");
});

test("qoder: inner result is non-JSON prose -> BrainError with the qoder-tagged parse-failure message (byte-identical review path)", async () => {
  // Pinning test (single-brain S2 fix): asserts the qoder-tagged JSON-parse
  // message survives callRaw's re-layering, not the shared
  // brainOutputFromText generic ("Brain response was not valid JSON...").
  const call = makeQoderProvider().call(
    baseOpts({
      spawnFn: fakeSpawn({ stdout: envelope("not json at all, just prose") }),
    }),
  );
  await expect(call).rejects.toThrow(BrainError);
  await expect(call).rejects.toThrow("qoder response was not valid JSON");
});

test("qoder: is_error:true envelope -> BrainError, content never trusted", async () => {
  const bad = envelope(CONFORMANT_INNER, { is_error: true, subtype: "error_max_turns" });
  await expect(
    makeQoderProvider().call(baseOpts({ spawnFn: fakeSpawn({ stdout: bad }) })),
  ).rejects.toThrow(BrainError);
});

test("qoder: non-zero exit gates BEFORE parsing, even with valid stdout", async () => {
  await expect(
    makeQoderProvider().call(
      baseOpts({ spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER), exitCode: 1, stderr: "boom" }) }),
    ),
  ).rejects.toThrow(/exited with code 1/);
});

test("parseCcForkEnvelope: non-JSON stdout -> BrainError", () => {
  expect(() => parseCcForkEnvelope("not json", "qoder")).toThrow(BrainError);
});

test("qoder: provider meta is quota-billed (inherits the generic per-provider cap)", () => {
  const meta = makeQoderProvider().meta;
  expect(meta.name).toBe("qoder");
  expect(meta.billing).toBe("quota");
  expect(meta.genAiSystem).toBe("alibaba");
});

// ---------------------------------------------------------------------
// Task 6: CodeBuddy instance — mirrors the qoder argv/meta/happy-path
// tests above. Real-output fixture + live smoke are DEFERRED (account was
// 429 "Credits exhausted" at authoring time) — these tests exercise the
// SAME synthetic conformant envelope as qoder (shared CC-fork shape).
// ---------------------------------------------------------------------

test("codebuddy: argv carries -p, --system-prompt, --output-format json, --tools '', model; context on stdin; SILTPOKE_INTERNAL=1", async () => {
  const captured: { argv?: string[]; stdin?: string; env?: Record<string, string>; cwd?: string } = {};
  const provider = makeCodeBuddyProvider();
  await provider.call(
    baseOpts({
      model: "glm-5.0",
      spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER), captured }),
    }),
  );
  expect(captured.argv?.[0]).toBe("codebuddy");
  expect(captured.argv).toContain("-p");
  expect(captured.argv).toContain("--system-prompt");
  expect(captured.argv).toContain("REVIEW RUBRIC");
  expect(captured.argv).toContain("--output-format");
  expect(captured.argv).toContain("json");
  expect(captured.argv).toContain("--tools");
  // Same load-bearing check as qoder — the value right after --tools MUST
  // be the empty string (read-only posture), not just "present somewhere".
  const toolsIdx = captured.argv!.indexOf("--tools");
  expect(captured.argv![toolsIdx + 1]).toBe("");
  expect(captured.argv).toContain("--model");
  expect(captured.argv).toContain("glm-5.0");
  expect(captured.stdin).toBe("diff under review");
  expect(captured.env?.SILTPOKE_INTERNAL).toBe("1");
  expect(captured.cwd).toBe("/repo/under/review");
});

test("codebuddy: --model omitted when no model configured (avoids invalid 'default')", async () => {
  const captured: { argv?: string[] } = {};
  await makeCodeBuddyProvider().call(
    baseOpts({ spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER), captured }) }),
  );
  expect(captured.argv).not.toContain("--model");
});

test("codebuddy: happy path parses a conformant envelope, quota usage (cost null), servedModel = configured", async () => {
  const result = await makeCodeBuddyProvider().call(
    baseOpts({ model: "glm-5.0", spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER) }) }),
  );
  expect(result.output.mood).toBe("happy");
  expect(result.usage.total_cost_usd).toBeNull();
  expect(result.usage.input_tokens).toBe(0);
  expect(result.servedModel).toBe("glm-5.0");
});

test("codebuddy: is_error:true envelope -> BrainError, content never trusted", async () => {
  const bad = envelope(CONFORMANT_INNER, { is_error: true, subtype: "error_max_turns" });
  await expect(
    makeCodeBuddyProvider().call(baseOpts({ spawnFn: fakeSpawn({ stdout: bad }) })),
  ).rejects.toThrow(BrainError);
});

test("codebuddy: non-zero exit gates BEFORE parsing, even with valid stdout", async () => {
  await expect(
    makeCodeBuddyProvider().call(
      baseOpts({ spawnFn: fakeSpawn({ stdout: envelope(CONFORMANT_INNER), exitCode: 1, stderr: "boom" }) }),
    ),
  ).rejects.toThrow(/exited with code 1/);
});

test("codebuddy: provider meta is quota-billed (inherits the generic per-provider cap)", () => {
  const meta = makeCodeBuddyProvider().meta;
  expect(meta.name).toBe("codebuddy");
  expect(meta.billing).toBe("quota");
  expect(meta.genAiSystem).toBe("tencent");
});

// ── codebuddy array-of-events envelope (real shape; #249 built blind on 429) ──
// codebuddy `-p --output-format json` returns claude's ARRAY of events with the
// result event last — NOT qoder's single object. #249 assumed they matched; the
// live smoke on 2026-07-11 (credits restored) proved otherwise. These lock the
// fix so the divergence can't silently regress.

const CB_ARRAY_FIXTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/codebuddy/brain-reply-raw.json"),
  "utf8",
);

// Wrap an inner reply in a codebuddy-shaped array-of-events (result event last).
function cbArray(innerResult: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { role: "assistant" } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: innerResult,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...over,
    },
  ]);
}

test("parseCcForkEnvelope: codebuddy REAL array fixture -> extracts the result event", () => {
  const { result } = parseCcForkEnvelope(CB_ARRAY_FIXTURE, "codebuddy");
  expect(result).toBe("Hi! How can I help you today?");
});

test("parseCcForkEnvelope: array-of-events finds the terminal result event + usage", () => {
  const { result, usage } = parseCcForkEnvelope(cbArray("the reply"), "codebuddy");
  expect(result).toBe("the reply");
  expect(usage.input_tokens).toBe(10);
  expect(usage.total_cost_usd).toBeNull(); // quota billing
});

test("parseCcForkEnvelope: array with NO result event -> BrainError (non-result envelope)", () => {
  const noResult = JSON.stringify([{ type: "system" }, { type: "assistant" }]);
  expect(() => parseCcForkEnvelope(noResult, "codebuddy")).toThrow(BrainError);
});

test("parseCcForkEnvelope: array result event with is_error:true -> BrainError", () => {
  const bad = cbArray("x", { is_error: true, subtype: "error_max_turns" });
  expect(() => parseCcForkEnvelope(bad, "codebuddy")).toThrow(BrainError);
});

test("codebuddy call(): real array-of-events envelope -> parsed BrainOutput", async () => {
  const provider = makeCodeBuddyProvider();
  const r = await provider.call(baseOpts({ spawnFn: fakeSpawn({ stdout: cbArray(CONFORMANT_INNER) }) }));
  expect(r.output.mood).toBe("happy");
  expect(r.servedModel).toBeUndefined(); // no --model passed
});

test("parseCcForkEnvelope: qoder SINGLE object still parses (no regression)", () => {
  const { result } = parseCcForkEnvelope(envelope("qoder reply"), "qoder");
  expect(result).toBe("qoder reply");
});

// ── codebuddy FENCED inner reply (real reviewer shape; live smoke 2026-07-12) ──
// Every inner reply above is BARE JSON — but a real codebuddy reviewer call wraps
// its JSON in a ```json code fence. Production survives that only because
// extractJsonString strips fences; nothing pinned it, so the one inner shape
// codebuddy ACTUALLY returns was the one shape untested. This fixture is the
// verbatim reply from a live `codebuddy -p` reviewer call (quota-billed, ~36s)
// against a planted off-by-one, captured 2026-07-12. See
// an internal design note
const CB_LIVE_FENCED = readFileSync(
  join(import.meta.dir, "../../fixtures/codebuddy/brain-reply-live-fenced.txt"),
  "utf8",
);

test("codebuddy call(): REAL live reviewer reply (```json-fenced) -> schema-valid BrainOutput", async () => {
  // Guard the fixture itself: if it ever stops being fenced, this test would
  // silently go back to exercising the already-covered bare-JSON path.
  expect(CB_LIVE_FENCED.trimStart().startsWith("```json")).toBe(true);

  const r = await makeCodeBuddyProvider().call(
    baseOpts({ spawnFn: fakeSpawn({ stdout: cbArray(CB_LIVE_FENCED) }) }),
  );

  // The fence was stripped and the real reply parsed all the way to BrainOutput.
  expect(r.output.severity).toBe("medium");
  expect(r.output.confidence).toBe("high");
  expect(r.output.mood).toBe("concerned");
  // It really reviewed: the critique names the file:line and the boundary flip.
  expect(r.output.critique_for_claude).toContain("src/auth/token.ts:38");
  expect(r.output.critique_for_claude).toContain("expiresAt");
  expect(r.output.evidence.length).toBeGreaterThan(0);
  // Quota-billed family: no USD cost is reported.
  expect(r.usage.total_cost_usd).toBeNull();
});
