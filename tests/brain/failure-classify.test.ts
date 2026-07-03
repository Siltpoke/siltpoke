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
