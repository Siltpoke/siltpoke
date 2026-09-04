// Guarded Brain call wrapper: classify → record → throttle 1-retry
// (jitter, retry-after, budget + daily-cap recheck).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError, type BrainCallResult } from "../../src/brain/brain";
import {
  makeGuardedCallBrain,
  resetQuotaWarnStateForTests,
  resetAgyClaudeFamilyWarnStateForTests,
} from "../../src/brain/brain-guarded";
import { loadReviewerProvider } from "../../src/brain/provider-select";
import type { ReviewerBrainProvider } from "../../src/brain/provider";
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

/** These fake providers exercise makeGuardedCallBrain, which only ever calls
 * `.call` — this stub exists solely to satisfy the `ReviewerBrainProvider`
 * interface (callRaw is a required member as of single-brain S2). */
const notUsedCallRaw: ReviewerBrainProvider["callRaw"] = async () => ({
  text: "",
  usage: {
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    input_tokens: 0, output_tokens: 0, total_cost_usd: null,
  },
});

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

test("provider dep is used as the call target when callBrainFn is absent (T1 seam)", async () => {
  let called = 0;
  const provider: ReviewerBrainProvider = {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
    callRaw: notUsedCallRaw,
    call: async () => {
      called++;
      return OK;
    },
  };
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  const result = await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(called).toBe(1);
  expect(result.output.bubble_short).toBe("ok");
});

test("callBrainFn injection wins over provider dep (test seam precedence unchanged)", async () => {
  let providerCalled = false;
  const provider: ReviewerBrainProvider = {
    meta: { name: "claude", billing: "usd", genAiSystem: "anthropic" },
    callRaw: notUsedCallRaw,
    call: async () => {
      providerCalled = true;
      return OK;
    },
  };
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider,
    callBrainFn: async () => OK,
  });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(providerCalled).toBe(false);
});

// ── T4 AC8: per-day call cap for quota-billed providers ──────────────────

function makeQuotaProvider(call: () => Promise<BrainCallResult>): ReviewerBrainProvider {
  return {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
    callRaw: notUsedCallRaw,
    call,
  };
}

test("Quota cap consumes 1 per call and blocks the 51st — blocked call spawns nothing", async () => {
  let calls = 0;
  const provider = makeQuotaProvider(async () => {
    calls++;
    return OK;
  });
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  for (let i = 0; i < 50; i++) {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  }
  expect(calls).toBe(50);
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(
    /brain-quota-cap/,
  );
  expect(calls).toBe(50); // the 51st call never reached the provider
});

test("Quota cap blocks immediately when already exhausted externally", async () => {
  let calls = 0;
  const provider = makeQuotaProvider(async () => {
    calls++;
    return OK;
  });
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: new Date().toISOString().slice(0, 10), count: 50 } },
  });
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(
    /daily call cap \(50\/day\) reached for quota-billed provider "codex"/,
  );
  expect(calls).toBe(0);
});

test("Quota cap resets on date rollover", async () => {
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: "2020-01-01", count: 50 } }, // exhausted on a stale date
  });
  let calls = 0;
  const provider = makeQuotaProvider(async () => {
    calls++;
    return OK;
  });
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(calls).toBe(1);
});

test("claude (usd) path NEVER consumes the quota-call counter", async () => {
  const guarded = makeGuardedCallBrain({ homeBase: tmp, callBrainFn: async () => OK });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(readBrainHealth(tmp).quota_calls_today).toEqual({});
});

// ── T4 AC13: warn-once for quota-billed providers ─────────────────────────

test("Warn-once: exactly one console.warn across two codex calls in the same process", async () => {
  resetQuotaWarnStateForTests();
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  try {
    const provider = makeQuotaProvider(async () => OK);
    const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
    await guarded({ systemPrompt: "s", contextBundle: "c" });
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } finally {
    console.warn = originalWarn;
  }
  expect(warnCalls.length).toBe(1);
  expect(String(warnCalls[0]?.[0])).toContain("codex");
});

test("Warn-once: claude (usd) calls never warn", async () => {
  resetQuotaWarnStateForTests();
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  try {
    const guarded = makeGuardedCallBrain({ homeBase: tmp, callBrainFn: async () => OK });
    await guarded({ systemPrompt: "s", contextBundle: "c" });
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } finally {
    console.warn = originalWarn;
  }
  expect(warnCalls.length).toBe(0);
});

// ── T4 fixup FIX1: retry must ALSO re-check the quota-cap for quota-billed
// providers (the pre-spawn check only covers the FIRST attempt) ──────────

test("Quota-billed throttle retry: count=49 pre-seeded -> first attempt consumes 49->50, retry check at 50 is REFUSED -> exactly 1 spawn, enriched FIRST error thrown", async () => {
  const today = new Date().toISOString().slice(0, 10);
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: today, count: 49 } },
  });
  let calls = 0;
  const provider: ReviewerBrainProvider = {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
    callRaw: notUsedCallRaw,
    call: async () => {
      calls++;
      throw throttleError();
    },
  };
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider,
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  let msg = "";
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (err) {
    msg = String(err);
  }
  expect(calls).toBe(1); // retry refused — no second spawn
  expect(msg).toContain("class=throttle attempts=1"); // enriched FIRST error, not a fresh quota error
  expect(readBrainHealth(tmp).quota_calls_today).toEqual({ codex: { date: today, count: 50 } });
});

test("Quota-billed throttle retry: count=48 pre-seeded -> first consumes 48->49, retry consumes 49->50 -> exactly 2 spawns", async () => {
  const today = new Date().toISOString().slice(0, 10);
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: today, count: 48 } },
  });
  let calls = 0;
  const provider: ReviewerBrainProvider = {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
    callRaw: notUsedCallRaw,
    call: async () => {
      calls++;
      if (calls === 1) throw throttleError();
      return OK;
    },
  };
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider,
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  const result = await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(calls).toBe(2);
  expect(result.output.bubble_short).toBe("ok");
  expect(readBrainHealth(tmp).quota_calls_today).toEqual({ codex: { date: today, count: 50 } });
});

// ── T7: agy cross-family-honesty warn-once (warn, allow — never block) ────

function makeAgyProviderForTest(call: () => Promise<BrainCallResult>): ReviewerBrainProvider {
  return {
    meta: { name: "agy", billing: "quota", genAiSystem: "google" },
    callRaw: notUsedCallRaw,
    call,
  };
}

function captureWarnings(): { warnCalls: unknown[][]; restore: () => void } {
  const warnCalls: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  return {
    warnCalls,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

test("agy + Claude-family model: warns exactly once across two calls, and the review still proceeds (not blocked)", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  const provider = makeAgyProviderForTest(async () => OK);
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  const { warnCalls, restore } = captureWarnings();
  let result1: BrainCallResult | undefined;
  let result2: BrainCallResult | undefined;
  try {
    result1 = await guarded({
      systemPrompt: "s",
      contextBundle: "c",
      model: "Claude Sonnet 4.6 (Thinking)",
    });
    result2 = await guarded({
      systemPrompt: "s",
      contextBundle: "c",
      model: "Claude Sonnet 4.6 (Thinking)",
    });
  } finally {
    restore();
  }
  // never blocked — both calls returned the successful result.
  expect(result1?.output.bubble_short).toBe("ok");
  expect(result2?.output.bubble_short).toBe("ok");
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(1);
  expect(String(familyWarnings[0]?.[0])).toContain("agy");
});

test("agy + Gemini model: never warns the cross-family-honesty message", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  const provider = makeAgyProviderForTest(async () => OK);
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  const { warnCalls, restore } = captureWarnings();
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c", model: "Gemini 3.1 Pro (Low)" });
  } finally {
    restore();
  }
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(0);
});

test("codex + a claude-looking model string: never warns the agy-specific cross-family message (agy-only check)", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  const provider = makeQuotaProvider(async () => OK); // meta.name === "codex"
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  const { warnCalls, restore } = captureWarnings();
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c", model: "Claude Sonnet 4.6 (Thinking)" });
  } finally {
    restore();
  }
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(0);
});

test("claude (usd) provider with a claude- model string: never warns the agy-specific cross-family message", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  const guarded = makeGuardedCallBrain({ homeBase: tmp, callBrainFn: async () => OK });
  const { warnCalls, restore } = captureWarnings();
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c", model: "claude-sonnet-4-6" });
  } finally {
    restore();
  }
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(0);
});

test("USD (claude) throttle retry never touches the quota-call counter", async () => {
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
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(calls).toBe(2); // retry proceeds unconditionally for usd providers
  expect(readBrainHealth(tmp).quota_calls_today).toEqual({});
});

// ── T4 fixup FIX2: pre-spawn quota-cap BrainError carries code:"quota_cap";
// the retry-refusal re-throw does NOT (it's the enriched FIRST error, a
// real spawn failure) ──────────────────────────────────────────────────────

test("Pre-spawn quota-cap BrainError carries code:\"quota_cap\"", async () => {
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: new Date().toISOString().slice(0, 10), count: 50 } },
  });
  const provider: ReviewerBrainProvider = {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
    callRaw: notUsedCallRaw,
    call: async () => OK,
  };
  const guarded = makeGuardedCallBrain({ homeBase: tmp, provider });
  let threw = false;
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(BrainError);
    expect((err as BrainError).code).toBe("quota_cap");
  }
  expect(threw).toBe(true);
});

test("Retry-refusal re-throw (throttle, quota cap hit mid-retry) does NOT carry code:\"quota_cap\" — it's the enriched FIRST spawn-failure error", async () => {
  const today = new Date().toISOString().slice(0, 10);
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: today, count: 49 } },
  });
  const provider: ReviewerBrainProvider = {
    meta: { name: "codex", billing: "quota", genAiSystem: "openai" },
    callRaw: notUsedCallRaw,
    call: async () => {
      throw throttleError();
    },
  };
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider,
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  let threw = false;
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(BrainError);
    expect((err as BrainError).code).toBeUndefined();
  }
  expect(threw).toBe(true);
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

// ── reviewer_model plumbing (single-brain #10 critic half): the agy honesty
// warn was DEAD before this track — the critic never threaded a model, so
// opts.model was always undefined and the `agy + Claude-family` predicate could
// never be true. These tests reproduce run-critic's exact wiring
// (loadReviewerProvider -> makeGuardedCallBrain(provider) -> call({ model })) to
// prove a CONFIGURED reviewer_model now arms the warn. callBrainFn is injected
// so no real agy spawns; enforceCapAndWarn still runs on the resolved provider.

test("plumbing: reviewer_provider=agy + Claude-family reviewer_model config now FIRES the honesty warn", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ reviewer_provider: "agy", reviewer_model: "Claude Sonnet 4.6 (Thinking)" }),
  );
  const resolved = await loadReviewerProvider(tmp);
  expect(resolved.provider.meta.name).toBe("agy");
  expect(resolved.model).toBe("Claude Sonnet 4.6 (Thinking)");

  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider: resolved.provider,
    callBrainFn: async () => OK, // no real agy spawn; warn preamble still runs
  });
  const { warnCalls, restore } = captureWarnings();
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c", model: resolved.model });
  } finally {
    restore();
  }
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(1);
  expect(String(familyWarnings[0]?.[0])).toContain("Claude Sonnet 4.6 (Thinking)");
});

test("plumbing: reviewer_provider=agy with NO reviewer_model stays DORMANT (model undefined -> warn cannot fire)", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  writeFileSync(join(tmp, "config.json"), JSON.stringify({ reviewer_provider: "agy" }));
  const resolved = await loadReviewerProvider(tmp);
  expect(resolved.provider.meta.name).toBe("agy");
  expect(resolved.model).toBeUndefined(); // agy family default = undefined (CLI's own default)

  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider: resolved.provider,
    callBrainFn: async () => OK,
  });
  const { warnCalls, restore } = captureWarnings();
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c", model: resolved.model });
  } finally {
    restore();
  }
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(0);
});

test("plumbing: reviewer_provider=agy + a Gemini reviewer_model does NOT fire the honesty warn", async () => {
  resetQuotaWarnStateForTests();
  resetAgyClaudeFamilyWarnStateForTests();
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ reviewer_provider: "agy", reviewer_model: "Gemini 3.1 Pro (Low)" }),
  );
  const resolved = await loadReviewerProvider(tmp);
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    provider: resolved.provider,
    callBrainFn: async () => OK,
  });
  const { warnCalls, restore } = captureWarnings();
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c", model: resolved.model });
  } finally {
    restore();
  }
  const familyWarnings = warnCalls.filter((args) =>
    String(args[0]).includes("not a true cross-family review"),
  );
  expect(familyWarnings.length).toBe(0);
});
