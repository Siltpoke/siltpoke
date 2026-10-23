// A rejected reply — the reviewer answered, but the answer failed JSON parsing
// or schema validation — gets ONE more attempt. Before this, the review was
// dropped on the spot: 2026-10-22, a live run of the published 1.4.0 lost a
// review to `bubble_long: invalid_type` while the same turn, reviewed by a
// second install, came back clean. A second ask is usually well-formed.
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
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-reply-retry-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const OK: BrainCallResult = {
  output: {
    mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
    findings: [],
    critique_for_claude: "", severity: "info", confidence: "high",
    xp_earned_events: [], evidence: [], reasoning: "t",
  },
  usage: {
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    input_tokens: 1, output_tokens: 1, total_cost_usd: 0,
  },
};

/** The shape every provider throws for a schema rejection: no `failure`, the reply attached. */
function schemaRejected(reply: unknown = { bubble_long: 7 }): BrainError {
  return new BrainError(
    "Brain response failed schema validation — bubble_long: invalid_type",
    undefined,
    undefined,
    undefined,
    reply,
  );
}

/** Same for a reply that was not JSON at all — the raw text is attached. */
function jsonRejected(text = "Sure! Here is my review:"): BrainError {
  return new BrainError(
    "Brain response was not valid JSON; possibly hallucinated prose around it",
    undefined,
    undefined,
    undefined,
    text,
  );
}

const noSleep = async (_ms: number) => {};

test("a schema-rejected reply is asked once more, and the second answer is returned", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw schemaRejected();
      return OK;
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  const result = await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(calls).toBe(2);
  expect(result).toEqual(OK);
  expect(typeof readBrainHealth(tmp).last_success_ts).toBe("string");
});

test("a reply that was not JSON is asked once more too", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw jsonRejected();
      return OK;
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).resolves.toEqual(OK);
  expect(calls).toBe(2);
});

test("rejected twice: exactly 2 calls, the SECOND reply is attached, and the message says it was retried", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw schemaRejected({ attempt: calls });
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  let err: BrainError | undefined;
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (e) {
    err = e as BrainError;
  }
  expect(calls).toBe(2);
  expect(err).toBeInstanceOf(BrainError);
  // audit-absence.ts classifies by this substring; the retry note must not hide it.
  expect(err!.message).toContain("failed schema validation");
  expect(err!.message).toContain("reply-rejected attempts=2");
  expect(err!.rawResponse).toEqual({ attempt: 2 });
  expect(err!.failure).toBeUndefined();
});

test("a rejected reply never touches health — it is not a subprocess failure", async () => {
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      throw schemaRejected();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow();
  const h = readBrainHealth(tmp);
  expect(h.last_failure).toBeNull();
  expect(h.consecutive_failures).toBe(0);
});

test("no second ask when the budget gate says no — the original error, untouched", async () => {
  let calls = 0;
  const first = schemaRejected();
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw first;
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => false,
  });
  let err: unknown;
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (e) {
    err = e;
  }
  expect(calls).toBe(1);
  expect(err).toBe(first);
});

test("no second ask when the daily outer-retry cap is used up", async () => {
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    retry_budget: { date: new Date().toISOString().slice(0, 10), outer_retries_used: 5 },
  });
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw schemaRejected();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(/schema validation/);
  expect(calls).toBe(1);
});

test("the second ask takes a slot from the review counter, and is refused at the cap", async () => {
  const today = new Date().toISOString().slice(0, 10);
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { review: { date: today, count: 49 } },
  });
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw schemaRejected();
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(/schema validation/);
  expect(calls).toBe(1); // 49 -> 50 on the first call; the cap (50) refuses the second
  expect(readBrainHealth(tmp).quota_calls_today).toEqual({ review: { date: today, count: 50 } });
});

test("the second ask uses one outer-retry slot", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw schemaRejected();
      return OK;
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await guarded({ systemPrompt: "s", contextBundle: "c" });
  expect(readBrainHealth(tmp).retry_budget.outer_retries_used).toBe(1);
});

test("a subprocess failure on the second ask is classified and recorded as attempt 2", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw schemaRejected();
      throw new BrainError("claude -p exited with code 1: rate limit exceeded", undefined, {
        exitCode: 1, stderr: "rate limit exceeded", stdout: "",
      });
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(
    /class=throttle attempts=2/,
  );
  expect(calls).toBe(2);
  expect(readBrainHealth(tmp).last_failure?.attempts).toBe(2);
});

test("a BrainError with no reply attached (e.g. 'claude -p reported an error') is NOT retried", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw new BrainError("claude -p reported an error: no result field");
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(/reported an error/);
  expect(calls).toBe(1);
});

test("a pre-spawn quota-cap skip is NOT retried", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      throw new BrainError("[brain-quota-cap] cap reached", undefined, undefined, "quota_cap");
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await expect(guarded({ systemPrompt: "s", contextBundle: "c" })).rejects.toThrow(/quota-cap/);
  expect(calls).toBe(1);
});

test("a throttle retry whose second answer is rejected carries the reply-rejected note too", async () => {
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) {
        throw new BrainError("claude -p exited with code 1: rate limit exceeded", undefined, {
          exitCode: 1, stderr: "rate limit exceeded", stdout: "",
        });
      }
      throw schemaRejected({ attempt: calls });
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  let err: BrainError | undefined;
  try {
    await guarded({ systemPrompt: "s", contextBundle: "c" });
  } catch (e) {
    err = e as BrainError;
  }
  expect(calls).toBe(2);
  expect(err!.message).toContain("reply-rejected attempts=2");
  expect(err!.message).toContain("failed schema validation");
  expect(err!.rawResponse).toEqual({ attempt: 2 });
});

test("the retry's role slot goes back when the second process never started", async () => {
  const today = new Date().toISOString().slice(0, 10);
  let calls = 0;
  const guarded = makeGuardedCallBrain({
    homeBase: tmp,
    callBrainFn: async () => {
      calls++;
      if (calls === 1) throw schemaRejected();
      throw new BrainError("claude spawn failed", undefined, {
        exitCode: null, stderr: "", stdout: "",
        spawnError: 'Error: Executable not found in $PATH: "claude"',
      });
    },
    sleepFn: noSleep,
    checkBudgetFn: async () => true,
  });
  await guarded({ systemPrompt: "s", contextBundle: "c" }).catch(() => {});
  expect(calls).toBe(2);
  // The first call took a slot and ran; the retry's slot was taken, then refunded.
  expect(readBrainHealth(tmp).quota_calls_today).toEqual({ review: { date: today, count: 1 } });
});
