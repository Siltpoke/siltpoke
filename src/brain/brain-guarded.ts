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
  BrainError,
  type BrainCallResult,
  type CallBrainOptions,
} from "./brain";
import {
  classifyBrainFailure,
  parseRetryAfterMs,
  type FailureClass,
} from "./failure-classify";
import { makeClaudeProvider, type CallRawResult, type ReviewerBrainProvider } from "./provider";
import { isClaudeFamilyModel } from "./agy-honesty";
import {
  readBrainHealth,
  writeBrainHealth,
  recordFailure,
  recordSuccess,
  tryConsumeOuterRetry,
  tryConsumeQuotaCall,
  QUOTA_CALL_DAILY_CAP,
} from "../state/brain-health";
import { loadBudgetConfig, evaluateBudget } from "../state/budget-config";
import { loadDailyRollup } from "../state/usage";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 2_000;
const EXCERPT_MAX = 200;

/**
 * Warn-once (AC13): first quota-billed provider call PER PROCESS gets a
 * single console.warn line. Module-level (not per-makeGuardedCallBrain-call)
 * because the daemon process re-invokes makeGuardedCallBrain per Stop event
 * while staying the same OS process — "per daemon lifetime" per spec §6.
 * Test-only reset below prevents state leaking between test files that both
 * exercise this path (bun caches the module once per process).
 */
let hasWarnedQuotaProvider = false;

/** @internal test seam — do not call in production. */
export function resetQuotaWarnStateForTests(): void {
  hasWarnedQuotaProvider = false;
}

/**
 * Warn-once (track #7 T7): first agy call PER PROCESS configured with a
 * Claude-family model gets a single console.warn line — same "module-level
 * boolean, per-process not per-call" mechanism as hasWarnedQuotaProvider
 * above, just gated on a different predicate (provider name === "agy" AND
 * the configured model is Claude-family, per isClaudeFamilyModel). This is
 * a config-honesty nudge, not a gate: the call always still runs (warn,
 * allow — never throw, never block; see the call site below).
 */
let hasWarnedAgyClaudeFamily = false;

/** @internal test seam — do not call in production. */
export function resetAgyClaudeFamilyWarnStateForTests(): void {
  hasWarnedAgyClaudeFamily = false;
}

export interface GuardedBrainDeps {
  /** ~/.siltpoke — where brain-health.json and the budget files live. */
  homeBase: string;
  /**
   * Call target abstraction (track #7 T1) — defaults to the claude provider
   * (a byte-identical wrap of callBrain). Only the critic seam supplies a
   * non-default provider (via provider-select); every other caller of
   * makeGuardedCallBrain gets today's claude behavior unchanged.
   */
  provider?: ReviewerBrainProvider;
  /** Test seam — defaults to the real callBrain (or the resolved provider). Wins over `provider` when supplied. */
  callBrainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  /** Test seam for `makeGuardedCallRaw` — defaults to the resolved provider's `callRaw`. Wins over `provider` when supplied. */
  callRawFn?: (opts: CallBrainOptions) => Promise<CallRawResult>;
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
 * Shared cap/warn preamble (single-brain identity #10, S2) — the ONLY place
 * that touches the quota-billed warn-once, the agy-claude-family warn-once,
 * and the per-day quota-cap gate. Both `makeGuardedCallBrain` (parse path)
 * and `makeGuardedCallRaw` (raw path) call this before invoking their call
 * target — "zero new cap infra" (spec §7): the raw path reuses the exact
 * same module-level warn flags and `tryConsumeQuotaCall` counter as the
 * parse path, so a quota-billed family is capped identically regardless of
 * which wrapper reaches it. Throws BrainError(code:"quota_cap") — same
 * pre-spawn, no-subprocess-ran shape both wrappers rely on. Never touches
 * health/retry state (that stays makeGuardedCallBrain-only).
 */
function enforceCapAndWarn(
  provider: ReviewerBrainProvider,
  opts: CallBrainOptions,
  homeBase: string,
  now: Date,
): void {
  // Warn-once (AC13): informational, independent of whether the cap below
  // ends up blocking this particular call — the user opted into a
  // quota-billed, eval-gated, non-pinnable-model reviewer and should know
  // once per process, not once per Stop event.
  if (provider.meta.billing === "quota" && !hasWarnedQuotaProvider) {
    hasWarnedQuotaProvider = true;
    console.warn(
      `[siltpoke] reviewer_provider="${provider.meta.name}" is quota-billed and eval-gated (review quality not yet certified for this provider) — spend is plan quota (not USD), and the served model is not pinnable under this provider's auth.`,
    );
  }

  // Cross-family-honesty warn-once (track #7 T7): agy's --model menu
  // includes Claude-family entries alongside Gemini ones — if the user
  // picked one of those, agy-as-reviewer is no longer a genuinely
  // different model family judging Claude's own output, which defeats the
  // self-preference-blind-spot value that motivated offering agy as a
  // reviewer at all. Warn, allow — NEVER block: this check never throws
  // and never prevents the call below from running.
  if (
    provider.meta.name === "agy" &&
    opts.model !== undefined &&
    isClaudeFamilyModel(opts.model) &&
    !hasWarnedAgyClaudeFamily
  ) {
    hasWarnedAgyClaudeFamily = true;
    console.warn(
      `[siltpoke] agy is running a Claude-family model ("${opts.model}") — not a true cross-family review.`,
    );
  }

  // Per-day call cap for quota-billed providers (AC8) — the runaway brake
  // the token budget gate can't see (a zero-usage quota failure is
  // invisible to evaluateBudget's token sums). Checked BEFORE spawn: a
  // blocked call never reaches the call target — a true $0 skip. USD
  // providers (claude) never consume or check this counter.
  if (provider.meta.billing === "quota") {
    if (!tryConsumeQuotaCall(homeBase, provider.meta.name, now)) {
      throw new BrainError(
        `[brain-quota-cap] daily call cap (${QUOTA_CALL_DAILY_CAP}/day) reached for quota-billed provider "${provider.meta.name}" — call skipped, $0 spent`,
        undefined,
        undefined,
        "quota_cap",
      );
    }
  }
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
  const provider = deps.provider ?? makeClaudeProvider();
  const call = deps.callBrainFn ?? ((opts: CallBrainOptions) => provider.call(opts));
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
      // Forwarded, not re-derived. This rebuild already dropped `code`
      // silently; it is unreachable for a reply-rejection error today only
      // because the caller early-throws when `failure === undefined`, and the
      // first site that sets both — a timeout that still captured partial
      // stdout is the obvious one — would lose the reply here with nothing to
      // notice. Cheaper to forward now than to re-find it later.
      err.code,
      err.rawResponse,
    );
  }

  return async (opts: CallBrainOptions): Promise<BrainCallResult> => {
    enforceCapAndWarn(provider, opts, deps.homeBase, now());

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
    // Quota-billed providers: the retry is a SECOND spawn and must ALSO
    // clear the daily call cap (AC8), or a throttled quota-billed provider
    // could double-spend past the cap via the throttle-retry path alone —
    // the pre-spawn check above only ever covers the FIRST attempt. Same
    // fresh-reread-consume-at-decision-time discipline as the outer-retry
    // cap. Refused → no retry, throw the same enriched first error (mirrors
    // the outer-retry-refused exit immediately above). USD providers
    // (claude) never touch this counter, so this never blocks a claude
    // retry.
    if (
      provider.meta.billing === "quota" &&
      !tryConsumeQuotaCall(deps.homeBase, provider.meta.name, now())
    ) {
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

/**
 * Build the guarded callRaw (single-brain identity #10, S2) — the raw-path
 * twin of `makeGuardedCallBrain` for role-routed consumers (role-brain.ts).
 * Deliberately thinner than the parse path: quota-cap + warn-once only, via
 * the shared `enforceCapAndWarn` preamble ("zero new cap infra", spec §7) —
 * NO retry, NO health recording. The retry/health machinery above is the
 * critic's own choke point; role-routed extract/chat calls are not retried
 * or health-tracked at this layer (their consumers own their own failure
 * handling, unchanged by this migration).
 */
export function makeGuardedCallRaw(
  deps: GuardedBrainDeps,
): (opts: CallBrainOptions) => Promise<CallRawResult> {
  const provider = deps.provider ?? makeClaudeProvider();
  const callRaw = deps.callRawFn ?? ((opts: CallBrainOptions) => provider.callRaw(opts));
  const now = deps.nowFn ?? (() => new Date());

  return async (opts: CallBrainOptions): Promise<CallRawResult> => {
    enforceCapAndWarn(provider, opts, deps.homeBase, now());
    return callRaw(opts);
  };
}
