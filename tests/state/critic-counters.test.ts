import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordToolRun,
  recordGateDecision,
  recordGuardReject,
  getTodayTelemetry,
  type CriticCounters,
} from "../../src/state/critic-counters";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-telemetry-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: recordToolRun increments correct cell + persists atomically
// ---------------------------------------------------------------------------

test("recordToolRun: increments correct tool/status cell and persists", async () => {
  await recordToolRun(homeBase, "tsc", "ok");
  await recordToolRun(homeBase, "tsc", "ok");
  await recordToolRun(homeBase, "tsc", "timeout");
  await recordToolRun(homeBase, "eslint", "not_installed");

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.toolStatusCounts.tsc.ok).toBe(2);
  expect(tel.toolStatusCounts.tsc.timeout).toBe(1);
  expect(tel.toolStatusCounts.eslint.not_installed).toBe(1);
  // Unchanged cells remain 0
  expect(tel.toolStatusCounts.ripgrep.ok).toBe(0);
});

test("recordToolRun: file exists on disk after call", async () => {
  await recordToolRun(homeBase, "git-diff", "ok");

  const today = new Date();
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  const path = join(homeBase, "telemetry", `critic-${y}-${m}-${d}.json`);
  expect(existsSync(path)).toBe(true);

  // Valid JSON
  const parsed: CriticCounters = JSON.parse(readFileSync(path, "utf8"));
  expect(parsed.toolStatusCounts["git-diff"].ok).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 2: New day → new file
// ---------------------------------------------------------------------------

test("getTodayTelemetry: returns empty telemetry when no file exists yet", async () => {
  const tel = await getTodayTelemetry(homeBase);
  expect(tel.totalCritiqueRuns).toBe(0);
  expect(tel.abstentionCount).toBe(0);
  expect(tel.toolStatusCounts.tsc.ok).toBe(0);
  expect(tel.guardRejectReasons).toEqual({});
});

test("recordGateDecision: HARD_SUPPRESS writes a new file each distinct day key", async () => {
  // We can't travel time easily, but we can verify the file name matches today
  await recordGateDecision(homeBase, "HARD_SUPPRESS");

  const today = new Date();
  const y = today.getUTCFullYear();
  const mo = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  const expectedFile = join(homeBase, "telemetry", `critic-${y}-${mo}-${d}.json`);
  expect(existsSync(expectedFile)).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: Concurrent recordToolRun calls — both increments persisted
// ---------------------------------------------------------------------------

test("recordToolRun: concurrent calls both persist (mutex)", async () => {
  // Fire 10 concurrent increments
  await Promise.all(
    Array.from({ length: 10 }, () => recordToolRun(homeBase, "ripgrep", "ok")),
  );

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.toolStatusCounts.ripgrep.ok).toBe(10);
});

// ---------------------------------------------------------------------------
// Test 4: recordGuardReject truncates long reasons + bins
// ---------------------------------------------------------------------------

test("recordGuardReject: truncates long reasons to 80 chars", async () => {
  const longReason = "A".repeat(200);
  await recordGuardReject(homeBase, longReason);

  const tel = await getTodayTelemetry(homeBase);
  const keys = Object.keys(tel.guardRejectReasons);
  expect(keys).toHaveLength(1);
  expect(keys[0]?.length).toBe(80);
});

test("recordGuardReject: bins duplicate truncated keys", async () => {
  const prefix = "snippet not in evidence_corpus: ";
  const r1 = `${prefix}TS2304: Cannot find name 'foo' — extra suffix that is long`;
  const r2 = `${prefix}TS2304: Cannot find name 'foo' — extra suffix that is different`;

  // Both truncate to the same 80-char key
  await recordGuardReject(homeBase, r1);
  await recordGuardReject(homeBase, r2);

  const tel = await getTodayTelemetry(homeBase);
  const key = r1.slice(0, 80);
  expect(tel.guardRejectReasons[key]).toBe(2);
});

test("recordGuardReject: increments normalRejectedCount", async () => {
  await recordGuardReject(homeBase, "some reason");
  await recordGuardReject(homeBase, "another reason");

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.normalRejectedCount).toBe(2);
});

// ---------------------------------------------------------------------------
// Test 5: getTodayTelemetry — empty default + correct shape
// ---------------------------------------------------------------------------

test("getTodayTelemetry: correct default shape with all tool names", async () => {
  const tel = await getTodayTelemetry(homeBase);
  // All four tools present
  expect(Object.keys(tel.toolStatusCounts).sort()).toEqual(
    ["eslint", "git-diff", "ripgrep", "tsc"],
  );
  // All status keys present for each tool
  for (const toolEntry of Object.values(tel.toolStatusCounts)) {
    expect(Object.keys(toolEntry).sort()).toEqual(
      ["error", "not_applicable", "not_installed", "ok", "output_too_large", "timeout"],
    );
  }
});

// ---------------------------------------------------------------------------
// Test 6: recordGateDecision — gate counters correct
// ---------------------------------------------------------------------------

test("recordGateDecision: HARD_SUPPRESS increments hardSuppressCount + abstentionCount", async () => {
  await recordGateDecision(homeBase, "HARD_SUPPRESS");
  await recordGateDecision(homeBase, "HARD_SUPPRESS");

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.totalCritiqueRuns).toBe(2);
  expect(tel.hardSuppressCount).toBe(2);
  expect(tel.abstentionCount).toBe(2);
  expect(tel.passiveBubbleCount).toBe(0);
  expect(tel.normalAttemptCount).toBe(0);
});

test("recordGateDecision: PASSIVE_BUBBLE increments passiveBubbleCount only", async () => {
  await recordGateDecision(homeBase, "PASSIVE_BUBBLE");

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.totalCritiqueRuns).toBe(1);
  expect(tel.passiveBubbleCount).toBe(1);
  expect(tel.hardSuppressCount).toBe(0);
  expect(tel.abstentionCount).toBe(0);
});

test("recordGateDecision: NORMAL increments normalAttemptCount", async () => {
  await recordGateDecision(homeBase, "NORMAL");

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.totalCritiqueRuns).toBe(1);
  expect(tel.normalAttemptCount).toBe(1);
  expect(tel.hardSuppressCount).toBe(0);
  expect(tel.abstentionCount).toBe(0);
});

test("recordGateDecision: mixed decisions accumulate correctly", async () => {
  await recordGateDecision(homeBase, "NORMAL");
  await recordGateDecision(homeBase, "NORMAL");
  await recordGateDecision(homeBase, "PASSIVE_BUBBLE");
  await recordGateDecision(homeBase, "HARD_SUPPRESS");

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.totalCritiqueRuns).toBe(4);
  expect(tel.normalAttemptCount).toBe(2);
  expect(tel.passiveBubbleCount).toBe(1);
  expect(tel.hardSuppressCount).toBe(1);
  expect(tel.abstentionCount).toBe(1);
});

// ---------------------------------------------------------------------------
// Test: recorder failure is swallowed (non-crashing)
// ---------------------------------------------------------------------------

test("recordToolRun: bad homeBase path doesn't throw (swallows disk error)", async () => {
  // Point homeBase at a file path that can't be a directory
  const badBase = join(tmp, "not-a-directory");
  // Create a file at that path so mkdir inside will fail
  const { writeFileSync } = await import("node:fs");
  writeFileSync(badBase, "I am a file, not a directory");

  // Should not throw
  await expect(recordToolRun(badBase, "tsc", "ok")).resolves.toBeUndefined();
});

// ---------------------------------------------------------------------------
// Regression: recordToolRun must ignore non-tool keys without throwing/logging.
// runTools() returns extra keys (securityFindings/owaspHints/webSearchSources)
// alongside the 4 ToolName cells; the caller used to iterate ALL of them via a
// lying cast, so recordToolRun was invoked with bogus tool names → the cell
// lookup threw a TypeError that was caught and logged 3× per critic run.
// ---------------------------------------------------------------------------

test("recordToolRun: unknown tool name is ignored — no throw, no error log, no key", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    // @ts-expect-error deliberately bogus tool name (mirrors the old lying cast).
    // Status is a valid value so the test isolates the tool-name guard.
    await recordToolRun(homeBase, "securityFindings", "ok");
  } finally {
    console.error = orig;
  }

  expect(errors).toHaveLength(0);

  const tel = await getTodayTelemetry(homeBase);
  expect(Object.keys(tel.toolStatusCounts).sort()).toEqual([
    "eslint",
    "git-diff",
    "ripgrep",
    "tsc",
  ]);
});

test("getTodayTelemetry: returns empty telemetry when file is corrupted", async () => {
  const today = new Date();
  const y = today.getUTCFullYear();
  const mo = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");

  mkdirSync(join(homeBase, "telemetry"), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(homeBase, "telemetry", `critic-${y}-${mo}-${d}.json`),
    "not valid json {{{",
  );

  const tel = await getTodayTelemetry(homeBase);
  expect(tel.totalCritiqueRuns).toBe(0);
});
