// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Guarded Brain call — the single retry/health choke point.
 *
 * Wraps callBrain with:
 *   1. failure classification (pure TS, src/brain/failure-classify.ts)
 *   2. health recording (single writer, src/state/brain-health.ts)
 *   3. throttle-only retry: EXACTLY 1 in-process retry, full jitter
 *      random(0, min(30s, 2s·2^attempt)), retry-after honored when
 *      parseable, daily budget gate + outer-retry cap (5/day) re-checked
 *      BEFORE the second attempt. All other classes: 0 retries.
 *
 * NO payload replay ever — the retry re-invokes the same
 * in-memory call once; nothing is persisted for later replay.
 *
 * Schema-validation / JSON-parse failures are NOT subprocess failures —
 * they carry no `failure` fields and pass through without touching health
 * (A0: 85× schema + 4× invalid-JSON never reach the classifier).
 */
import {
  callBrain,
  BrainError,
  type BrainCallResult,
  type CallBrainOptions,
} from "./brain";
import {
  classifyBrainFailure,
  parseRetryAfterMs,
  type FailureClass,
} from "./failure-classify";
import {
  readBrainHealth,
  writeBrainHealth,
  recordFailure,
  recordSuccess,
  tryConsumeOuterRetry,
} from "../state/brain-health";
import { loadBudgetConfig, evaluateBudget } from "../state/budget-config";
import { loadDailyRollup } from "../state/usage";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 2_000;
const EXCERPT_MAX = 200;

export interface GuardedBrainDeps {
  /** ~/.siltpoke — where brain-health.json and the budget files live. */
  homeBase: string;
  /** Test seam — defaults to the real callBrain. */
  callBrainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  /** Test seam — defaults to setTimeout sleep. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Test seam — defaults to Math.random. */
  randomFn?: () => number;
  /** Test seam — defaults to "budget stage is ok" via evaluateBudget. */
  checkBudgetFn?: () => Promise<boolean>;
  /** Test seam — defaults to () => new Date(). */
  nowFn?: () => Date;
}

async function defaultBudgetOk(homeBase: string, now: Date): Promise<boolean> {
  try {
    const config = await loadBudgetConfig(homeBase);
    const rollup = await loadDailyRollup(homeBase, now, config.resetAtMinutes);
    return evaluateBudget(rollup, config).stage === "ok";
  } catch {
    // Can't verify the budget → be conservative, no retry.
    return false;
  }
}

function failureExcerpt(err: BrainError): string {
  const f = err.failure!;
  const text = `${f.spawnError ?? ""}${f.stderr}${f.stdout}`.trim();
  // Keep the TAIL — stderr/stdout are already tail-sliced upstream and error
  // payloads end with the informative part (the head is boilerplate preamble).
  return text.slice(-EXCERPT_MAX);
}

/**
 * Build the guarded callBrain. Drop-in replacement for `callBrain` —
 * same signature, same throw type (BrainError), with class + attempt
 * count appended to the message so the failure lands legibly in
 * brain-calls.jsonl telemetry.
 */
export function makeGuardedCallBrain(
  deps: GuardedBrainDeps,
): (opts: CallBrainOptions) => Promise<BrainCallResult> {
  const call = deps.callBrainFn ?? callBrain;
  const sleep =
    deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.randomFn ?? Math.random;
  const now = deps.nowFn ?? (() => new Date());
  const budgetOk =
    deps.checkBudgetFn ?? (() => defaultBudgetOk(deps.homeBase, now()));

  function recordAndEnrich(
    err: BrainError,
    cls: FailureClass,
    attempts: number,
  ): BrainError {
    const ts = now().toISOString();
    const health = readBrainHealth(deps.homeBase);
    writeBrainHealth(
      deps.homeBase,
      recordFailure(health, {
        class: cls,
        exit_code: err.failure?.exitCode ?? null,
        stderr_excerpt: failureExcerpt(err),
        ts,
        attempts,
      }),
    );
    return new BrainError(
      `[brain-failure class=${cls} attempts=${attempts}] ${err.message}`,
      err,
      err.failure,
    );
  }

  return async (opts: CallBrainOptions): Promise<BrainCallResult> => {
    let firstError: BrainError;
    try {
      const result = await call(opts);
      writeBrainHealth(
        deps.homeBase,
        recordSuccess(readBrainHealth(deps.homeBase), now().toISOString()),
      );
      return result;
    } catch (err) {
      // Non-subprocess failures (schema validation, JSON parse) pass
      // through untouched — out of classifier scope.
      if (!(err instanceof BrainError) || err.failure === undefined) throw err;
      firstError = err;
    }

    // Every failed ATTEMPT is recorded — two failed attempts in one turn
    // count as 2 consecutive failures for the surfacing predicate.
    const cls = classifyBrainFailure(firstError.failure!);
    const enrichedFirst = recordAndEnrich(firstError, cls, 1);
    if (cls !== "throttle") {
      throw enrichedFirst;
    }

    // Throttle: exactly 1 retry — but only when the daily budget gate AND
    // the outer-retry cap (5/day) both allow it.
    if (!(await budgetOk())) {
      throw enrichedFirst;
    }
    // tryConsumeOuterRetry is the SOLE cap arbiter: it re-reads the health
    // file fresh and consumes the slot at DECISION time (before the
    // up-to-30s sleep). No preliminary stale-read check — a single fresh
    // check avoids the midnight-rollover false refusal. Residual ms-window
    // race accepted (cost: one extra retry).
    if (!tryConsumeOuterRetry(deps.homeBase, now())) {
      throw enrichedFirst;
    }

    const f = firstError.failure!;
    const retryAfterMs = parseRetryAfterMs(`${f.stderr}\n${f.stdout}`);
    // 2 ** 1: the exponent is the attempt index of the single (only) retry —
    // constant because the policy is exactly one outer retry.
    const capMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** 1);
    const delayMs =
      retryAfterMs !== null
        ? Math.min(retryAfterMs, MAX_BACKOFF_MS)
        : Math.floor(random() * capMs);
    await sleep(delayMs);

    try {
      const result = await call(opts);
      writeBrainHealth(
        deps.homeBase,
        recordSuccess(readBrainHealth(deps.homeBase), now().toISOString()),
      );
      return result;
    } catch (err2) {
      if (!(err2 instanceof BrainError) || err2.failure === undefined) throw err2;
      const cls2 = classifyBrainFailure(err2.failure);
      throw recordAndEnrich(err2, cls2, 2);
    }
  };
}
