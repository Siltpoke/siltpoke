// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`, agy half — on Windows the prompt leaves argv entirely and goes
 * over stdin as one NDJSON line, and the reply comes back as an event stream.
 *
 * Separate file rather than an addition to agy.test.ts, which is pinned at 520
 * lines by the length ratchet (pins only move down).
 *
 * The wire format is not guessed. Every shape asserted here was produced by a
 * real `agy 1.2.11` run on this machine 2026-09-26: a claude-shaped
 * `{"type":"user",…}` line was REJECTED (`stream input message is missing the
 * "event" field`), a bare `-p` made agy take the next flag as its prompt, and
 * the `{"event":"user","message":{…}}` form below exited 0 and answered.
 */

import { afterAll, beforeAll, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../../src/brain/brain";
import type { CallBrainOptions } from "../../../src/brain/brain";
import {
  agyStreamJsonInput,
  buildAgyArgv,
  parseAgyStreamJson,
} from "../../../src/brain/providers/agy-wire";
import { makeAgyProvider } from "../../../src/brain/providers/agy";

// Hermeticity, same harness and same reason as agy.test.ts:18-54, which spells
// it out: `call()` always runs the best-effort reaper in a `finally`, and
// `reapAgyConversations()` with no args resolves its defaults to the REAL
// `<ANTIGRAVITY_HOME>/conversations/` and `<SILTPOKE_HOME>/agy-reviewer-
// conversations.json` — where it deletes. This file spawns nothing real, but
// without these two overrides the reaper still reads and writes the maintainer's
// own `~/.gemini` and `~/.siltpoke`. It is a no-op TODAY only because the live
// registry holds fewer entries than `keepLast`, which is exactly why leaving it
// out would be found late. Raised by a cross-check of this change.
let sandboxHome: string;
let prevAntigravityHome: string | undefined;
let prevSiltpokeHome: string | undefined;

beforeAll(() => {
  sandboxHome = mkdtempSync(join(tmpdir(), "agy-wire-test-sandbox-"));
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

/** What agy actually exited with — the parse attaches it so the classifier and
 * the circuit breaker can see an envelope-level failure at all. exit 0 is the
 * interesting case: without the context, an ERROR envelope behind a clean exit
 * reaches nobody's retry accounting. */
const OK_CTX = { exitCode: 0, stderr: "" };

/** The real event sequence, trimmed: init, a step_update per step, result. */
function streamJsonStdout(
  over: { status?: string; response?: string; error?: string } = {},
): string {
  return [
    JSON.stringify({ event: "init", conversation_id: "c1", init: { cwd: "/repo" } }),
    JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: "c1", step_index: 0, state: "DONE", step_type: "user_input" },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "partial and WRONG",
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "c1",
        status: over.status ?? "SUCCESS",
        response: over.response ?? CONFORMANT_INNER,
        ...(over.error === undefined ? {} : { error: over.error }),
        duration_seconds: 4,
        num_turns: 1,
        usage: { input_tokens: 13320, output_tokens: 35 },
      },
    }),
    "",
  ].join("\n");
}

// ── the input line ───────────────────────────────────────────────────────

test("agyStreamJsonInput: agy's own envelope, not Claude Code's", () => {
  const line = agyStreamJsonInput("RUBRIC and diff");
  expect(line.endsWith("\n")).toBe(true);
  // One NDJSON message, so exactly one newline — a prompt containing newlines
  // must not split into several turns.
  expect(line.trimEnd()).not.toContain("\n");

  const parsed = JSON.parse(line) as Record<string, unknown>;
  // The measured rejection was specifically a MISSING `event` field, and a
  // claude-shaped `type` in its place.
  expect(parsed.event).toBe("user");
  expect(parsed.type).toBeUndefined();
  expect(parsed.message).toEqual({
    role: "user",
    content: [{ type: "text", text: "RUBRIC and diff" }],
  });
});

test("agyStreamJsonInput: a prompt with newlines and quotes survives as one line", () => {
  const prompt = 'line one\nline "two"\n\ttabbed';
  const line = agyStreamJsonInput(prompt);
  expect(line.trimEnd().split("\n")).toHaveLength(1);
  const parsed = JSON.parse(line) as {
    message: { content: { text: string }[] };
  };
  expect(parsed.message.content[0]!.text).toBe(prompt);
});

test("the stream-json argv: -p carries an ATTACHED empty value, and both formats are set", () => {
  // Asserted through buildAgyArgv rather than the flags constant, which is
  // private: what reaches the process is the built argv, and a constant that is
  // right while the argv is wrong would pass.
  const argv = buildAgyArgv({
    prompt: "the rubric and the diff",
    streamJson: true,
    printTimeout: "90s",
  });

  // `-p` on its own made agy read the NEXT FLAG as the prompt:
  //   Error: -p took "--input-format" as its prompt
  expect(argv).toContain("-p=");
  expect(argv).not.toContain("-p");
  // agy's --help: stream-json input REQUIRES stream-json output.
  const joined = argv.join(" ");
  expect(joined).toContain("--input-format stream-json");
  expect(joined).toContain("--output-format stream-json");
  // And the prompt is nowhere in argv, which is the whole point.
  expect(joined).not.toContain("the rubric and the diff");
});

// ── the output stream ────────────────────────────────────────────────────

test("parseAgyStreamJson: takes the terminal result event, not the step deltas", () => {
  const text = parseAgyStreamJson(streamJsonStdout(), OK_CTX);
  expect(text).toBe(CONFORMANT_INNER);
  // The deltas are a partial, drifting copy of the same reply — reassembling
  // them instead would have produced this.
  expect(text).not.toContain("partial and WRONG");
});

test("parseAgyStreamJson: an ERROR result throws even though the stream parsed fine", () => {
  // Probed live: a malformed input line produced status ERROR with an empty
  // response. Read as success that is a review that silently found nothing.
  expect(() =>
    parseAgyStreamJson(
      streamJsonStdout({
        status: "ERROR",
        response: "",
        error: 'stream input message is missing the "event" field',
      }),
      OK_CTX,
    ),
  ).toThrow(/ERROR.*missing the "event" field/);
});

test("parseAgyStreamJson: an empty response on a SUCCESS result still throws", () => {
  expect(() => parseAgyStreamJson(streamJsonStdout({ response: "" }), OK_CTX)).toThrow(
    /no response text/,
  );
});

test("parseAgyStreamJson: no result event at all throws", () => {
  const noResult = [
    JSON.stringify({ event: "init", conversation_id: "c1" }),
    JSON.stringify({ event: "step_update", step_update: { state: "DONE" } }),
  ].join("\n");
  expect(() => parseAgyStreamJson(noResult, OK_CTX)).toThrow(/no result event/);
});

test("parseAgyStreamJson: unparseable noise lines are tolerated, not fatal", () => {
  const withNoise = `warming up…\n{not json at all\n${streamJsonStdout()}`;
  expect(parseAgyStreamJson(withNoise, OK_CTX)).toBe(CONFORMANT_INNER);
});

test("parseAgyStreamJson: the LAST result event wins", () => {
  const two = [
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "first" } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: CONFORMANT_INNER } }),
  ].join("\n");
  expect(parseAgyStreamJson(two, OK_CTX)).toBe(CONFORMANT_INNER);
});

// ── through the provider ─────────────────────────────────────────────────

interface Seen {
  argv?: string[];
  stdinWrites: string[];
  stdinEnded: boolean;
  stdinKind?: unknown;
}

function capturingSpawn(seen: Seen, stdoutText: string): typeof Bun.spawn {
  return ((cmd: string[], options: { stdin?: unknown }) => {
    seen.argv = cmd;
    seen.stdinKind = options.stdin;
    return {
      stdin:
        options.stdin === "pipe"
          ? {
              write: (s: string) => {
                seen.stdinWrites.push(s);
              },
              end: () => {
                seen.stdinEnded = true;
              },
            }
          : undefined,
      stdout: new Response(stdoutText).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

const baseOpts = (over: Partial<CallBrainOptions> = {}): CallBrainOptions => ({
  systemPrompt: "REVIEW RUBRIC",
  contextBundle: "diff under review",
  cwd: "/repo/under/review",
  ...over,
});

test("agy on win32: prompt goes to stdin, and neither the rubric nor the diff is in argv", async () => {
  const seen: Seen = { stdinWrites: [], stdinEnded: false };
  const { output } = await makeAgyProvider().call(
    baseOpts({ platform: "win32", spawnFn: capturingSpawn(seen, streamJsonStdout()) }),
  );

  expect(output.bubble_short).toBe("looks good");
  const argv = seen.argv!.join(" ");
  expect(argv).not.toContain("REVIEW RUBRIC");
  expect(argv).not.toContain("diff under review");
  expect(seen.argv).toContain("-p=");
  expect(seen.argv).toContain("--input-format");
  expect(seen.stdinKind).toBe("pipe");

  // The prompt really did reach stdin — a flag set with nothing written would
  // satisfy every assertion above while agy waited on an empty pipe.
  expect(seen.stdinWrites.join("")).toContain("REVIEW RUBRIC");
  expect(seen.stdinWrites.join("")).toContain("diff under review");
  // And stdin was CLOSED: agy runs a turn per line and reads until EOF, so
  // leaving it open hangs the review until the kill-timer.
  expect(seen.stdinEnded).toBe(true);

  // --sandbox must survive every edit to this path (a spike caught agy without
  // it browsing a sibling repo and running its test suite).
  expect(seen.argv).toContain("--sandbox");
});

test("agy off win32: prompt still rides argv and stdin stays ignored", async () => {
  const seen: Seen = { stdinWrites: [], stdinEnded: false };
  // Off win32 stdout is the bare reply, NOT an event stream.
  const { output } = await makeAgyProvider().call(
    baseOpts({ platform: "darwin", spawnFn: capturingSpawn(seen, CONFORMANT_INNER) }),
  );

  expect(output.bubble_short).toBe("looks good");
  expect(seen.argv).toContain("-p");
  expect(seen.argv!.join(" ")).toContain("REVIEW RUBRIC");
  expect(seen.stdinKind).toBe("ignore");
  expect(seen.stdinWrites).toEqual([]);
});

test("agy on win32: an ERROR envelope behind exit 0 is a failure, not an empty review", async () => {
  const seen: Seen = { stdinWrites: [], stdinEnded: false };
  await expect(
    makeAgyProvider().call(
      baseOpts({
        platform: "win32",
        spawnFn: capturingSpawn(
          seen,
          streamJsonStdout({ status: "ERROR", response: "", error: "quota exhausted" }),
        ),
      }),
    ),
  ).rejects.toThrow(/ERROR.*quota exhausted/);
});

test("the envelope gate's failure is CLASSIFIABLE — otherwise the breaker never sees it", () => {
  // `brain-guarded.ts:266-268` re-throws a BrainError with no `failure` field
  // untouched, out of the classifier's scope. So an ERROR envelope behind exit 0
  // would reach no retry accounting and never latch the breaker — the `[28]`
  // shape on a new path. Raised by a cross-check of this change.
  let thrown: unknown;
  try {
    parseAgyStreamJson(
      streamJsonStdout({ status: "ERROR", response: "", error: "quota exhausted" }),
      { exitCode: 0, stderr: "some stderr tail" },
    );
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(BrainError);
  const failure = (thrown as BrainError).failure;
  expect(failure).toBeDefined();
  expect(failure?.exitCode).toBe(0);
  expect(failure?.stderr).toBe("some stderr tail");
  // The stdout tail has to carry the envelope, or the classifier is reading air.
  expect(failure?.stdout).toContain("quota exhausted");
});

test("the real captured stream parses — the hand-built fixture above is not the only oracle", () => {
  // Captured verbatim from `agy 1.2.11` on 2026-09-26 (the run that established
  // this wire format), with only the `init.cwd` value replaced. The trimmed
  // fixture the other tests use is hand-written, so on its own it can only ever
  // confirm what its author believed the shape was.
  const captured = readFileSync(
    join(import.meta.dir, "../../fixtures/agy/stream-json-reply.jsonl"),
    "utf8",
  );
  expect(captured).toContain('"event": "init"');
  expect(captured).toContain('"event": "step_update"');
  expect(parseAgyStreamJson(captured, OK_CTX)).toBe("PROBEOK\n");
});

test("agy on win32: a spawn that yields no writable stdin fails LOUDLY", async () => {
  // Without an assertion here the guard is only ever taken on its false branch —
  // deleting the whole `if` kept every other test green. A silent skip would
  // leave agy waiting on an empty pipe until the kill-timer, i.e. a timeout
  // standing in for a wiring bug.
  const noStdinSpawn = ((_cmd: string[], _options: unknown) =>
    ({
      stdin: undefined,
      stdout: new Response(streamJsonStdout()).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    }) as unknown as ReturnType<typeof Bun.spawn>) as unknown as typeof Bun.spawn;

  await expect(
    makeAgyProvider().call(baseOpts({ platform: "win32", spawnFn: noStdinSpawn })),
  ).rejects.toThrow(/without a writable stdin/);
});

test("buildAgyArgv: -p= stays ahead of the format flags, whatever else is appended", () => {
  // The probed failure is positional: a `-p` not attached to its value swallows
  // the next flag as the prompt. `--model` and the rest are pushed AFTER the
  // spread, so only ordering keeps that from coming back.
  const argv = buildAgyArgv({
    prompt: "unused on this path",
    streamJson: true,
    model: "gemini-3-pro",
    printTimeout: "90s",
    logFilePath: "/tmp/x.log",
  });
  expect(argv[0]).toBe("agy");
  expect(argv[1]).toBe("-p=");
  expect(argv.indexOf("-p=")).toBeLessThan(argv.indexOf("--input-format"));
  expect(argv.indexOf("-p=")).toBeLessThan(argv.indexOf("--model"));
  // And the prompt is nowhere in argv on this path.
  expect(argv.join(" ")).not.toContain("unused on this path");
});
