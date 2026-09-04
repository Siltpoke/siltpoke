// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * When the Brain's reply is rejected, the reply itself is thrown away — so the
 * one case where you need to see what the model said is the one case nothing
 * kept.
 *
 * MEASURED (2026-09-01, `~/.siltpoke/`). Of 349 fired reviews since 2026-08-25,
 * 42 ended `HARD_SUPPRESS`, and **all 42 had no Brain output at all**: 39 were
 * the reply failing to parse or validate, 1 was a killed subprocess, and every
 * one of them had already spent 61–240 seconds and real money. The failing
 * `siltpoke.brain.find` span records `siltpoke.input` and no `siltpoke.output`;
 * the successful one records both (`phases/normal.ts` calls `tracer.setOutput`
 * on the success path only). The reply exists inside `callBrain`'s scope at the
 * moment it is rejected and is dropped when the error propagates.
 *
 * WHY THIS BLOCKS THE NEXT SLICE, and is therefore its own change. The next
 * step is #692's principle applied to SHAPE — one malformed field should cost
 * that field, not the whole answer. The live failures name their fields
 * (`evidence.0.file: invalid_type`, `bubble_short: too_small`, prose wrapped
 * around the JSON), but zod's `invalid_type` does not say what the value WAS,
 * so a coercion written today would be written against a guess. This repo's own
 * rule is to collect real output before proposing a change; this makes that
 * possible and nothing more.
 *
 * SCOPE, stated so it is not mistaken for the fix: recording the reply changes
 * no decision anywhere. The review is still discarded. This is instrumentation.
 *
 * WHAT THE NEXT SLICE THEN DID TO THIS FILE (2026-09-01, the same day). The
 * shape repair landed WITHOUT the probe ever firing — it had captured nothing,
 * because the only brain failure between the two merges predated the probe by
 * two and a half hours. It could be written anyway because three of the four
 * residual classes turned out to be repairable without knowing any value: a
 * malformed evidence item is dropped whatever it holds, and a cosmetic field
 * falls back whatever it held.
 *
 * The consequence for this file is that those classes NO LONGER REJECT, so the
 * fixtures below moved to `critique_for_claude: invalid_type` — the one class
 * deliberately left rejecting, precisely because its repair is the one that
 * cannot be written without a real value. The probe's remaining job is that
 * class, and it is still the only way to see it.
 */
import { describe, expect, test } from "bun:test";
import { BrainError, callBrain } from "../../src/brain/brain";

function fakeSpawn(stdoutText: string): typeof Bun.spawn {
  return ((_cmd: string[], _options: unknown) => ({
    stdin: { write(_c: string) {}, end() {} },
    stdout: new Response(stdoutText).body,
    stderr: new Response("").body,
    exited: Promise.resolve(0),
    kill() {},
  })) as unknown as typeof Bun.spawn;
}

/** The `claude -p --output-format json` envelope, with `result` as the model text. */
function envelope(resultText: string): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "result", subtype: "success", is_error: false, result: resultText },
  ]);
}

async function errorFrom(resultText: string): Promise<BrainError> {
  try {
    await callBrain({
      systemPrompt: "x",
      contextBundle: "x",
      spawnFn: fakeSpawn(envelope(resultText)),
    });
  } catch (err) {
    return err as BrainError;
  }
  throw new Error("expected callBrain to reject this reply");
}

const valid = {
  mood: "happy",
  pose: "base",
  bubble_short: "ok",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
};

describe("a rejected Brain reply is kept, not dropped", () => {
  test("a schema failure carries the reply that failed", async () => {
    // `critique_for_claude: invalid_type` is a REAL live failure (2 of the 33
    // schema rejections since 2026-08-25, this repo). Its whole diagnostic value
    // is knowing what the payload actually was — here, a number.
    //
    // It used to be `evidence.0.file: invalid_type`, which no longer reaches
    // this path: the shape repair drops that citation and lets the review
    // through. `critique_for_claude` is the class deliberately left rejecting,
    // BECAUSE its repair is the one that cannot be written without seeing a real
    // value — so it is also the class this probe still has to serve.
    const reply = { ...valid, critique_for_claude: 42 };
    const err = await errorFrom(JSON.stringify(reply));

    expect(err.message).toContain("critique_for_claude");
    expect(err.rawResponse).toEqual(reply);
  });

  test("the reply is kept whole — not just the field zod named", async () => {
    // A coercion has to know the shape around the bad field: whether the other
    // evidence items were fine, whether the critique text was there at all.
    // Keeping only the named field would answer the question that was already
    // answered by the message.
    const reply = {
      ...valid,
      critique_for_claude: ["src/a.ts line 3 is wrong", "src/b.ts line 9 too"],
      evidence: [
        { tool: "tsc", file: "src/b.ts", line: 9, snippet: "a snippet past the floor" },
      ],
    };
    const err = await errorFrom(JSON.stringify(reply));

    expect(err.rawResponse).toEqual(reply);
  });

  test("a reply that is not JSON at all carries its raw text", async () => {
    // 2 of the 42 were "not valid JSON; possibly hallucinated prose around it".
    // There is no object to keep, so the text is what gets kept — and the text
    // is exactly what a JSON-extraction fix would need to be written against.
    const prose = 'Sure! Here is the review:\n{"mood":"happy"} \nHope that helps!';
    const err = await errorFrom(prose);

    expect(err.message).toContain("not valid JSON");
    expect(err.rawResponse).toBe(prose);
  });

  test("NEGATIVE: a failure with no reply carries nothing, rather than an empty-looking one", async () => {
    // Asserting absence, not just presence. A spawn/exit failure has no reply
    // to record, and `rawResponse: ""` or `{}` there would read on a dashboard
    // exactly like "the model returned nothing" — a different claim, and a
    // false one. This is the repo's own recurring blind spot.
    const dead = ((_cmd: string[], _options: unknown) => ({
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response("").body,
      stderr: new Response("boom").body,
      exited: Promise.resolve(1),
      kill() {},
    })) as unknown as typeof Bun.spawn;

    let err: BrainError | null = null;
    try {
      await callBrain({ systemPrompt: "x", contextBundle: "x", spawnFn: dead });
    } catch (e) {
      err = e as BrainError;
    }
    expect(err).not.toBeNull();
    expect(err!.rawResponse).toBeUndefined();
  });

  test("the reply never reaches the MESSAGE — that channel stays path:code only", async () => {
    // #647 deliberately keeps reviewed source out of the message, because the
    // span input is redacted for the same reason. Recording the reply on a
    // field must not undo that by leaking it into the string everyone logs.
    const secret = "SUPER_SECRET_SOURCE_LINE";
    const reply = { ...valid, critique_for_claude: { text: secret } };
    const err = await errorFrom(JSON.stringify(reply));

    expect(err.message).not.toContain(secret);
    expect(JSON.stringify(err.rawResponse)).toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// The DELIVERY half. Everything above tests `BrainError`; nothing above notices
// whether the critic phases actually WRITE the reply anywhere. Reverting the
// two `setOutput` calls in `phases/normal.ts` and `phases/passive-bubble.ts`
// would leave every test above green — the shape this repo keeps shipping.
// ---------------------------------------------------------------------------
import { Tracer } from "../../src/observability/tracer";
import type { Span } from "../../src/observability/types";
import type { TraceStore } from "../../src/observability/storage";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { type RunCriticDeps, type RunCriticOpts, runCritic } from "../../src/critic/run-critic";
import type { GitDiffHunk, ToolName, ToolResult } from "../../src/critic/tools/types";

function caps(): ProjectCapabilities {
  return {
    cwd: "/r", hasGit: true, hasTsc: true, hasEslint: false, hasRipgrep: false,
    tsconfigPaths: [], eslintConfigPaths: [], detectedAt: Date.now(), configMtimes: {},
  };
}

function hunk(file: string, n: number): GitDiffHunk {
  return {
    file, oldStart: n, oldLines: 1, newStart: n, newLines: 1,
    header: `@@ -${n},1 +${n},1 @@`, body: `-old-${file}-${n}\n+new-${file}-${n}`,
  };
}

/** tsc reports an error, so `classifyToolOutput` routes to NORMAL. */
function toolsWithFinding(): Record<ToolName, ToolResult> & {
  securityFindings: never[]; owaspHints: never[]; webSearchSources: never[];
} {
  return {
    tsc: {
      tool: "tsc", status: "ok",
      parsed: [{ file: "src/a/foo.ts", line: 10, col: 5, severity: "error", code: "TS2322", message: "Type mismatch." }],
      raw: "src/a/foo.ts(10,5): error TS2322: Type mismatch.",
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [hunk("src/a/foo.ts", 1)], raw: "diff" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [], owaspHints: [], webSearchSources: [],
  };
}

function criticOpts(tracer: Tracer, store: TraceStore): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: "/r",
    changedFiles: ["src/a/foo.ts"],
    caps: caps(),
    tracer,
    traceStore: store,
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-raw",
      cwd: "/r",
      stateBase: "/r/.siltpoke",
    },
  };
}

describe("the critic phase writes the rejected reply onto the failing span", () => {
  test("a schema failure in NORMAL leaves brain.find carrying the reply, not just an error string", async () => {
    const written: Span[] = [];
    const store = { writeSpan: async (s: Span) => { written.push(s); } } as unknown as TraceStore;
    const tracer = new Tracer();

    // `critique_for_claude`, not `evidence.0.file`: since the shape repair landed,
    // a malformed citation is dropped and the review is delivered, so a fixture
    // built on it would describe a production state that can no longer happen.
    const REJECTED = { mood: "happy", critique_for_claude: { text: "the-line", line: 42 } };
    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsWithFinding(),
      callBrainFn: async () => {
        throw new BrainError(
          "Brain response failed schema validation — critique_for_claude: invalid_type",
          new Error("zod"),
          undefined,
          undefined,
          REJECTED,
        );
      },
      writeCritiqueFn: async () => ({ id: "c-raw", path: "/r" }),
    };

    const result = await runCritic(criticOpts(tracer, store), deps);
    expect(result.decision).toBe("HARD_SUPPRESS");

    const brainFind = written.filter((s) => s.name === "siltpoke.brain.find");
    expect(brainFind.length).toBe(1);
    const span = brainFind[0]!;
    expect(span.status?.code).toBe("ERROR");

    // The assertion the change exists for. Before it, this attribute was
    // absent on every failing span while present on every succeeding one.
    const output = String(span.attributes["siltpoke.output"] ?? "");
    expect(output).not.toBe("");
    expect(output).toContain("the-line");
    expect(output).toContain("42");
  });

  test("NEGATIVE: a failure with no reply leaves the attribute absent, not empty", async () => {
    // A spawn failure. An empty `siltpoke.output` here would render in the span
    // panel exactly like "the model replied with nothing".
    const written: Span[] = [];
    const store = { writeSpan: async (s: Span) => { written.push(s); } } as unknown as TraceStore;
    const tracer = new Tracer();

    const deps: RunCriticDeps = {
      runToolsFn: async () => toolsWithFinding(),
      callBrainFn: async () => {
        throw new BrainError("claude -p exited with code 143");
      },
      writeCritiqueFn: async () => ({ id: "c-raw", path: "/r" }),
    };

    await runCritic(criticOpts(tracer, store), deps);
    const span = written.find((s) => s.name === "siltpoke.brain.find")!;
    expect(span.status?.code).toBe("ERROR");
    expect(span.attributes["siltpoke.output"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The PRODUCTION path. Everything above drives `callBrain` from `brain.ts` —
// which `run-critic.ts:175-179` reaches only as the FALLBACK, when there is no
// homeBase or no resolved reviewer. The live claude reviewer goes
// `makeGuardedCallBrain` -> `provider.call` -> `brainOutputFromText`, i.e.
// `parse-raw.ts`. Deleting the `rawResponse` argument from BOTH sites there left
// every test above green (the independent reviewer's I2). These aim at the file
// the real reviewer actually rejects replies in.
//
// SCOPE of `rawResponse`, so a later reader does not read the remaining
// `new BrainError(...)` sites as misses: it is set where a MODEL REPLY is
// rejected — `brain.ts`, `parse-raw.ts`, the three CLI-fork providers,
// `reflection.ts`, `summarizer.ts`, `run-diff-summary.ts`. The sites that stay
// bare reject an ENVELOPE (`claude -p stdout was not a JSON array`, `codex exec
// produced no agent_message event`, …) or never had a reply at all (spawn,
// exit, timeout, quota cap). Those are transport failures, a different claim.
// ---------------------------------------------------------------------------
import { brainOutputFromText } from "../../src/brain/parse-raw";

describe("the production parse path keeps the rejected reply too", () => {
  function errorFromText(text: string): BrainError {
    try {
      brainOutputFromText(text);
    } catch (err) {
      return err as BrainError;
    }
    throw new Error("expected brainOutputFromText to reject this reply");
  }

  test("a schema failure carries the parsed reply", () => {
    const reply = { ...valid, critique_for_claude: ["prod-line"] };
    const err = errorFromText(JSON.stringify(reply));

    expect(err.message).toContain("critique_for_claude");
    expect(err.rawResponse).toEqual(reply);
  });

  test("a not-JSON reply carries the text, prose and all", () => {
    // `parseRawJson` is handed the ORIGINAL text, not what `extractJsonString`
    // salvaged — when extraction fails, the prose around the block is the
    // diagnostic.
    const prose = "Here you go!\n{not json at all}\nCheers";
    const err = errorFromText(prose);

    expect(err.message).toContain("not valid JSON");
    expect(err.rawResponse).toBe(prose);
  });
});

describe("PASSIVE_BUBBLE records the rejected reply as well as NORMAL", () => {
  // 70% of fired reviews take this branch, and it carries its own copy of the
  // change. Reverting only its `setOutput` left the whole repo green.
  function cleanTools(): Record<ToolName, ToolResult> & {
    securityFindings: never[]; owaspHints: never[]; webSearchSources: never[];
  } {
    return {
      tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
      eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
      // Clean tools + real hunks = PASSIVE_BUBBLE, not the HARD_SUPPRESS no-op.
      "git-diff": { tool: "git-diff", status: "ok", parsed: [hunk("src/a/foo.ts", 1)], raw: "diff" },
      ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
      securityFindings: [], owaspHints: [], webSearchSources: [],
    };
  }

  test("a schema failure in PASSIVE_BUBBLE leaves brain.find carrying the reply", async () => {
    const written: Span[] = [];
    const store = { writeSpan: async (s: Span) => { written.push(s); } } as unknown as TraceStore;
    const tracer = new Tracer();

    // Same reason as the NORMAL fixture above: an empty `bubble_short` is now
    // filled from `bubble_long`, so it no longer produces a rejection.
    const REJECTED = { mood: "happy", critique_for_claude: ["pb-line"] };
    const deps: RunCriticDeps = {
      runToolsFn: async () => cleanTools(),
      callBrainFn: async () => {
        throw new BrainError(
          "Brain response failed schema validation — critique_for_claude: invalid_type",
          new Error("zod"),
          undefined,
          undefined,
          REJECTED,
        );
      },
      writeCritiqueFn: async () => ({ id: "c-pb", path: "/r" }),
    };

    const result = await runCritic(criticOpts(tracer, store), deps);
    // Guard the fixture itself: if this ever stopped routing to PASSIVE_BUBBLE
    // the test would silently re-cover NORMAL and prove nothing new.
    expect(result.decision).toBe("HARD_SUPPRESS");

    const span = written.find((s) => s.name === "siltpoke.brain.find")!;
    expect(span.status?.code).toBe("ERROR");
    const output = String(span.attributes["siltpoke.output"] ?? "");
    expect(output).toContain("pb-line");
  });
});
