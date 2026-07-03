// Guarded Brain call wrapper: classify → record → throttle 1-retry
// (jitter, retry-after, budget + daily-cap recheck).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError, type BrainCallResult } from "../../src/brain/brain";
import { makeGuardedCallBrain } from "../../src/brain/brain-guarded";
import {
  readBrainHealth,
  writeBrainHealth,
  freshBrainHealth,
} from "../../src/state/brain-health";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-guarded-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const OK: BrainCallResult = {
  output: {
    mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
    critique_for_claude: "", severity: "info", confidence: "high",
    xp_earned_events: [], evidence: [], reasoning: "t",
  },
  usage: {
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    input_tokens: 1, output_tokens: 1, total_cost_usd: 0,
  },
};

function throttleError(extra = ""): BrainError {
  return new BrainError(`claude -p exited with code 1: rate limit exceeded${extra}`, undefined, {
    exitCode: 1, stderr: `rate limit exceeded${extra}`, stdout: "",
  });
}

function ambiguousError(): BrainError {
  return new BrainError("claude -p exited with code 1: ", undefined, {
    exitCode: 1, stderr: "", stdout: "",
  });
}

const noSleep = async (_ms: number) => {};

test("Throttle failure gets exactly ONE in-process retry; success on attempt 2 records success", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw throttleError();
      return OK;
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  const result = await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(calls).toBe(2);
  expect(result.output.bubble_short).toBe("ok");
  const h = readBrainHealth(tmp);
  expect(h.consecutive_failures).toBe(0);
  expect(h.last_success_ts).not.toBeNull();
  expect(h.retry_budget.outer_retries_used).toBe(1);
});

test("Throttle failing BOTH attempts throws with class + attempts visible in the message (telemetry)", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw throttleError();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  let msg = "";
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (err) {
    msg = String(err);
  }
  expect(calls).toBe(2);
  expect(msg).toContain("class=throttle");
  expect(msg).toContain("attempts=2");
  const h = readBrainHealth(tmp);
  expect(h.consecutive_failures).toBe(2);
  expect(h.last_failure?.attempts).toBe(2);
});

test("Ambiguous (empty-tail exit 1) gets ZERO retries — the intended honest behavior", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw ambiguousError();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(/class=ambiguous attempts=1/);
  expect(calls).toBe(1);
  expect(readBrainHealth(tmp).last_failure?.class).toBe("ambiguous");
});

test("Retry-after is honored when parseable (sleep = 7000ms)", async () => {
  let calls = 0;
  const delays: number[] = [];
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw throttleError(", retry-after: 7");
      return OK;
    },
    sleepFn: async (ms) => { delays.push(ms); },
    checkBudgetFn: async () => true,
  });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(delays).toEqual([7000]);
});

test("Jitter delay = random(0, min(30s, 2s*2^attempt)) when no retry-after", async () => {
  let calls = 0;
  const delays: number[] = [];
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw throttleError();
      return OK;
    },
    sleepFn: async (ms) => { delays.push(ms); },
    randomFn: () => 0.5,
    checkBudgetFn: async () => true,
  });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  // attempt 1 → cap min(30000, 2000 * 2^1) = 4000; 0.5 * 4000 = 2000
  expect(delays).toEqual([2000]);
});

test("Retry re-checks the budget gate — no second attempt when budget not ok", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw throttleError();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => false,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("Daily outer-retry cap (5/day) blocks the second attempt when exhausted", async () => {
  const exhausted = {
    ...freshBrainHealth(),
    retry_budget: { date: new Date().toISOString().slice(0, 10), outer_retries_used: 5 },
  };
  writeBrainHealth(tmp, exhausted);
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw throttleError();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("Stderr excerpt keeps the LAST 200 chars — error payloads end with the informative part", async () => {
  // >200-char stderr: long preamble head, informative tail.
  const padding = "x".repeat(220);
  const tailMarker = "FINAL-INFORMATIVE-TAIL";
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      throw new BrainError("claude -p exited with code 1: rate limit exceeded", undefined, {
        exitCode: 1,
        stderr: `rate limit exceeded ${padding} ${tailMarker}`,
        stdout: "",
      });
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => false, // single attempt — one recorded excerpt
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow();
  const excerpt = readBrainHealth(tmp).last_failure?.stderr_excerpt ?? "";
  expect(excerpt.length).toBeLessThanOrEqual(200);
  expect(excerpt.endsWith(tailMarker)).toBe(true); // tail survives
  expect(excerpt.startsWith("rate limit exceeded")).toBe(false); // head dropped, not tail
});

test("Retry slot consume re-reads the health file fresh — external cap bump between the initial read and consume aborts the retry", async () => {
  let calls = 0;
  const today = new Date().toISOString().slice(0, 10);
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw throttleError();
    },
    sleepFn: noSleep,
    // The budget check runs BETWEEN the initial health read and the consume
    // step — exhaust the daily outer-retry cap externally here to simulate a
    // concurrent Stop hook consuming the remaining slots in that window.
    checkBudgetFn: async () => {
      writeBrainHealth(tmp, {
        ...readBrainHealth(tmp),
        retry_budget: { date: today, outer_retries_used: 5 },
      });
      return true;
    },
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(
    /class=throttle attempts=1/,
  );
  expect(calls).toBe(1); // retry must NOT happen
  // The consume step must not have pushed usage past the cap off a stale read.
  expect(readBrainHealth(tmp).retry_budget.outer_retries_used).toBe(5);
});

test("Retry slot is consumed BEFORE the backoff sleep (no over-consume window while sleeping)", async () => {
  let calls = 0;
  let usedAtSleepTime = -1;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw throttleError();
      return OK;
    },
    sleepFn: async (_ms) => {
      usedAtSleepTime = readBrainHealth(tmp).retry_budget.outer_retries_used;
    },
    checkBudgetFn: async () => true,
  });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(usedAtSleepTime).toBe(1); // slot already persisted when the sleep starts
});

test("schema-validation failures are OUT of classifier scope — health untouched", async () => {
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      throw new BrainError("Brain response failed schema validation");
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(/schema validation/);
  const h = readBrainHealth(tmp);
  expect(h.last_failure).toBeNull();
  expect(h.consecutive_failures).toBe(0);
});
