// Pure failure classification.
//
// Marker regexes frozen against REAL captured evidence (2026-06-11):
//   - 256× `claude -p exited with code 1: ` (stderr tail EMPTY) → ambiguous
//   - 14× exit 143 (90s kill-timer SIGTERM) → resource
//   - EAGAIN/posix_spawn + exit 137 in errors.log → resource
//   - NO throttle markers ever observed → throttle set = standard Anthropic
//     API shapes only; anything unrecognized buckets to ambiguous, NEVER throttle.
import { test, expect } from "bun:test";
import {
  classifyBrainFailure,
  parseRetryAfterMs,
} from "../../src/brain/failure-classify";

// ── ambiguous: the observed dominant real-world shape ──────────────────────

test("exit 1 with EMPTY stderr and stdout classifies ambiguous (observed 256x — zero retries)", () => {
  expect(
    classifyBrainFailure({ exitCode: 1, stderr: "", stdout: "" }),
  ).toBe("ambiguous");
});

test("unrecognized stderr text buckets to ambiguous, never throttle (contingency)", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "something weird happened in the pipeline",
      stdout: "",
    }),
  ).toBe("ambiguous");
});

// ── resource: observed exit codes + spawn EAGAIN ────────────────────────────

test("exit 143 (90s kill-timer SIGTERM) classifies resource (observed 14x)", () => {
  expect(
    classifyBrainFailure({ exitCode: 143, stderr: "", stdout: "" }),
  ).toBe("resource");
});

test("exit 137 classifies resource (observed in errors.log)", () => {
  expect(
    classifyBrainFailure({ exitCode: 137, stderr: "", stdout: "" }),
  ).toBe("resource");
});

test("EAGAIN posix_spawn classifies resource (observed marker)", () => {
  expect(
    classifyBrainFailure({
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: "EAGAIN: resource temporarily unavailable, posix_spawn '/bin/bash'",
    }),
  ).toBe("resource");
});

test("EAGAIN text on stderr classifies resource", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "EAGAIN: resource temporarily unavailable",
      stdout: "",
    }),
  ).toBe("resource");
});

// ── throttle: standard Anthropic markers (none observed locally) ────────────

test("rate-limit marker on stderr classifies throttle", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "API Error: 429 rate limit exceeded",
      stdout: "",
    }),
  ).toBe("throttle");
});

test("overloaded marker on STDOUT classifies throttle (claude -p errors land on stdout with --output-format json)", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "",
      stdout: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    }),
  ).toBe("throttle");
});

// ── codex markers (track #7 T2, AC10) ───────────────────────────────────────

test("codex quota/usage-limit phrasing classifies throttle", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "usage limit reached for this account",
      stdout: "",
    }),
  ).toBe("throttle");
});

test("codex 'quota exceeded' phrasing classifies throttle", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "",
      stdout: "quota exceeded, try again later",
    }),
  ).toBe("throttle");
});

test("codex 'login required' / 'codex login' phrasing classifies permanent", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "login required — run `codex login` first",
      stdout: "",
    }),
  ).toBe("permanent");
});

// ── permanent ───────────────────────────────────────────────────────────────

test("binary-missing spawn error (ENOENT) classifies permanent", () => {
  expect(
    classifyBrainFailure({
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: "ENOENT: no such file or directory, posix_spawn 'claude'",
    }),
  ).toBe("permanent");
});

test("auth / not-logged-in markers classify permanent", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "Invalid API key · Please run /login",
      stdout: "",
    }),
  ).toBe("permanent");
});

test("unknown-flag marker classifies permanent", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "error: unknown option '--no-session-persistence'",
      stdout: "",
    }),
  ).toBe("permanent");
});

test("credit-exhausted marker classifies permanent", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "Your credit balance is too low to access the Anthropic API",
      stdout: "",
    }),
  ).toBe("permanent");
});

// Windows, measured 2026-09-24 on a real machine (defect `[26]`): the runtime
// refuses to hand a cmd.exe special character to a `.bat`/`.cmd`, and npm's
// `claude` on Windows IS `claude.cmd`. The review prompt always contains such a
// character, so this failure is DETERMINISTIC — the same turn fails identically
// forever. Classified `ambiguous` it got a 5-minute breaker that reopened on its
// own, so every commit paid for one more failed call.
//
// THE FIELD IS THE POINT, not just the text. This is a spawn-time validation
// throw: the process never starts, so every provider reports it as
// `spawnError` with `exitCode: null` and EMPTY streams. The first version of
// this test fed the message on `stderr` — a shape production never produces —
// and was green while the production shape still classified `ambiguous`.
const WINDOWS_ARGV_REFUSAL =
  "TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[5]' contains a cmd.exe " +
  "special character and cannot be safely passed to a .bat/.cmd file. Received " +
  '"You are Fuzzyglob, a slime AI buddy embedded i';

test("Windows cmd.exe argv refusal classifies permanent, not ambiguous", () => {
  expect(
    classifyBrainFailure({
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: WINDOWS_ARGV_REFUSAL,
    }),
  ).toBe("permanent");
});

// The same refusal reported as the error class alone, with no prose. Both
// shapes must latch — matching only the sentence would leave a runtime that
// words it differently back on the 5-minute retry loop.
test("the ERR_INVALID_ARG_VALUE class alone classifies permanent", () => {
  expect(
    classifyBrainFailure({
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: "TypeError [ERR_INVALID_ARG_VALUE]",
    }),
  ).toBe("permanent");
});

// The same error CLASS with a different sentence, and a different meaning.
// Verbatim from a real ~/.siltpoke/brain-health.json (macOS, 2026-09-29): the
// reviewed diff contained a raw NUL character, it rode argv, and the runtime
// refused it. That is a fact about ONE input, not about the machine — but it
// carries ERR_INVALID_ARG_VALUE, so it latched the breaker and every review on
// that machine was skipped for two days (562 turns) until someone looked.
const NUL_BYTE_REFUSAL =
  "TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[3]' must be a string " +
  'without null bytes. Received "You are Bangbang, a cat AI buddy embedded in ' +
  "Claude Code's statusline. You watch Claude write c";

test("a null byte in an argv entry is about this input, not the machine — never latched", () => {
  expect(
    classifyBrainFailure({
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: NUL_BYTE_REFUSAL,
    }),
  ).toBe("ambiguous");
});

// The reason those markers are confined to `spawnError`, asserted rather than
// left as a comment. `permanent` LATCHES the breaker until /siltpoke:siltpoke-wake, and
// the stdout tail carries assistant prose whenever the envelope fails to parse
// (the timeout case) — so a review that merely QUOTES this error, which a review
// of this very file would, must not silence the pet. The repo has already been
// bitten once by the mirror image of this: `rate_limit_event` in the event
// stream matched the throttle marker and authorised a second paid spawn
// (brain.ts:195-201).
test("the same text arriving as model output does NOT latch the breaker", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "",
      stdout:
        'the reviewed diff adds /ERR_INVALID_ARG_VALUE/ so a "cmd.exe special character" is rejected',
    }),
  ).toBe("ambiguous");
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: WINDOWS_ARGV_REFUSAL,
      stdout: "",
    }),
  ).toBe("ambiguous");
});

// ── precedence: permanent beats throttle beats resource ─────────────────────

test("permanent marker wins over throttle marker (auth never retried)", () => {
  expect(
    classifyBrainFailure({
      exitCode: 1,
      stderr: "Invalid API key. Also: rate limit exceeded",
      stdout: "",
    }),
  ).toBe("permanent");
});

// ── retry-after parsing (honored when parseable) ────────────────────────────

test("parseRetryAfterMs extracts seconds from retry-after header text", () => {
  expect(parseRetryAfterMs('429 too many requests, retry-after: 7')).toBe(7000);
});

test("parseRetryAfterMs extracts 'retry after N seconds' prose", () => {
  expect(parseRetryAfterMs("Please retry after 12 seconds")).toBe(12000);
});

test("parseRetryAfterMs returns null when absent or unparseable", () => {
  expect(parseRetryAfterMs("rate limit exceeded")).toBeNull();
  expect(parseRetryAfterMs("")).toBeNull();
});
