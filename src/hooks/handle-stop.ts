// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrainCallResult,
  BrainError,
  type CallBrainOptions,
} from "../brain/brain";
import { loadBrainConfigSync } from "../brain/brain-config";
import { makeGuardedCallBrain } from "../brain/brain-guarded";
import { type CostConfig, loadCostConfig } from "../brain/cost-config";
import { buildSystemPrompt, loadPersonality } from "../brain/personality";
import { assembleSystemPromptWithFunnel, type MemoryFunnel } from "../brain/prompt-assembly";
import { detectFileTypes } from "../brain/rule-selector";
import type { BrainOutput } from "../brain/schema";
import { consumeWake } from "../cli/wake";
import { type Case1CaptureConfig, loadCase1CaptureConfig } from "../config/case1-capture-config";
import { getProjectCapabilities } from "../critic/capabilities";
import { type RunCriticDeps, type RunCriticResult, runCritic } from "../critic/run-critic";
// NOTE: this pulls the few-shot chain (→ fastembed → @anush008/tokenizers, a
// platform-specific native binding) into the Stop-hook bundle. `fastembed` is
// externalized for the stop bundles in scripts/build-dist.ts so the native
// binding is NOT baked into dist/ (it would break check:dist's cross-platform
// byte-compare); embedder.ts falls back to a stub if it can't resolve at runtime.
import { buildAntiExamplesBlock } from "../few-shot/inject";
import { siltpokeRoot } from "../installer/paths";
import { type CaptureDeps, captureCase1Pre } from "../memory/case1-capture";
import { nodeCaptureDeps } from "../memory/case1-capture-node-deps";
import { consolidate } from "../memory/consolidate";
import { maybeLaunchDistilWorker } from "../memory/distil-launcher";
import { lineContentFingerprint } from "../memory/line-fingerprint";
import { type CoreMemory, readMemory } from "../memory/memory";
import {
  enqueuePending,
  type PendingCritique,
  pendingCritiqueSchema,
  pendingQueuePath,
} from "../memory/pending-queue";
import { type RecentEntry, readRecent, resolveRecentPath } from "../memory/recent";
import { TraceStore } from "../observability/storage";
import { Tracer } from "../observability/tracer";
import type { WhyHost } from "../repo-graph/why-index";
import {
  type ContextBundle,
  confineToRepo,
  extractChangedFiles,
  extractLatestUserMessage,
  packContext,
} from "../router/context";
import { extractTranscriptTurns } from "../router/extract-turns";
import { captureGitBaseline } from "../router/git-snapshot";
import { type HookEvent, shouldFire } from "../router/router";
import {
  buildSignature,
  commitHash,
  evaluateSkip,
} from "../router/skip-detector";
import { anyCodeChanged } from "../router/docs-gate";
import { collectReviewUnitFacts, writeAnchor } from "../router/git-facts";
import { decideReviewUnit, NUDGE_QUIET_MINUTES } from "../router/review-unit";
import { loadReviewUnit } from "../config/review-unit-config";
import {
  clearBreaker,
  isBreakerOpen,
  readBrainHealth,
  writeBrainHealth,
} from "../state/brain-health";
import { type BudgetConfig, evaluateBudget, loadBudgetConfig } from "../state/budget-config";
import { writeCritique } from "../state/critique";
import { isMuted } from "../state/mute";
import {
  addXp,
  readProgression,
  writeProgression,
} from "../state/progression";
import { isQuietHour, loadQuietHoursConfig } from "../state/quiet-hours";
import { readState, writeState } from "../state/state";
import {
  appendUsageEvent,
  loadDailyRollup,
  type UsageEvent,
} from "../state/usage";
import {
  type MenubarSideEffectDeps,
  notifyReview,
  refreshMenubar,
} from "./menubar-refresh";
import { resolveHostCwd } from "./resolve-host-cwd";
import { readSessionBaseline, resolveOrCaptureSessionHeadSha } from "./session-baseline";
import { maybeRecordWhy } from "./why-index-wiring";

export function logPath(env: NodeJS.ProcessEnv): string {
  return join(siltpokeRoot(env), "brain-calls.jsonl");
}

export async function appendJsonLine(
  env: NodeJS.ProcessEnv,
  obj: unknown,
): Promise<void> {
  try {
    await mkdir(siltpokeRoot(env), { recursive: true });
    await appendFile(logPath(env), `${JSON.stringify(obj)}\n`);
  } catch {
    // Logger failures must never crash the hook.
  }
}

/**
 * Track #7 T3 (AC7) — provider truth for ledger/telemetry rows. runCritic
 * resolves the reviewer provider once and carries its meta on every
 * RunCriticResult branch (even HARD_SUPPRESS, where no call may have
 * happened); this reads it back with the historical-row-compatible default
 * (absent providerMeta ⇒ claude/usd, matching every pre-track row on disk).
 */
function providerFields(
  r: RunCriticResult,
  authorFamily: string,
): { provider: string; billing: "usd" | "quota"; model: string | undefined; authorFamily: string } {
  return {
    provider: r.providerMeta?.name ?? "claude",
    billing: r.providerMeta?.billing ?? "usd",
    model: r.servedModel,
    authorFamily,
  };
}

type ProviderFields = ReturnType<typeof providerFields>;

/**
 * Read-half memory funnel (eval design §2.1) flattened onto the telemetry row.
 *
 * Flat rather than nested so the fields are greppable in the JSONL the way every
 * other telemetry column is.
 *
 * ABSENT and ZERO mean different things, and keeping them apart is the whole
 * point: `memory_rules_count` read 0 in 805/805 rows not because memory was
 * empty but because the field was only ever emitted on the dead legacy path,
 * and those two states looked identical. So:
 *
 *   present  — this row describes a run that BUILT a critic prompt. The counts
 *              say how far the rules got, including the case where the prompt
 *              was built and the provider then refused the call (quota cap):
 *              there the funnel is what separates "rules never got injected"
 *              from "rules got injected, the provider said no".
 *   absent   — this row does not describe a run with a critic prompt. Two ways
 *              to get here: the gate suppressed before assembly, or the run was
 *              skipped upstream (review-unit / no code change / dedupe).
 *              As of the ⏱ review-trigger-unit change (spec D5) the review-unit
 *              and code-change gates run BEFORE buildPromptContext, so their
 *              rows really do mean "nothing was assembled". The dedupe row
 *              still lands after assembly, so "absent" across a day of rows is
 *              read as "no review was attempted with this prompt", not as
 *              "nothing was computed".
 */
function memoryFunnelFields(r: RunCriticResult): Record<string, number> {
  const f = "memoryFunnel" in r ? r.memoryFunnel : undefined;
  if (!f) return {};
  return {
    rules_in_store: f.rules_in_store,
    rules_scope_matched: f.rules_scope_matched,
    rules_selected: f.rules_selected,
    rules_bytes_in_prompt: f.rules_bytes_in_prompt,
  };
}

/**
 * Per-section prompt sizes, `prompt_bytes_*`-prefixed so they read as one
 * group beside the funnel's four and can never collide with it.
 *
 * `rules_bytes_in_prompt` above measures ONE section, the learned-rules
 * listing, and it is the only size this row has ever carried. Everything else
 * in the prompt was unmeasured — which is why, when the non-cached part of the
 * prompt tripled between 2026-08-02 and 08-08 (12.8k → 39.9k tokens, while
 * `rules_bytes_in_prompt` never passed 385 bytes) and the critic call's rate
 * of hitting its 90s kill timer went 8% → 41%, the growth could be seen in
 * aggregate and not attributed to anything. These rows are what make the next
 * such regression locatable from the log rather than reconstructible only by
 * reading code. Absent (not zero) when assembly never ran — the same
 * distinction the funnel keeps.
 */
function promptBytesFields(r: RunCriticResult): Record<string, number> {
  const b = "promptBytes" in r ? r.promptBytes : undefined;
  if (!b) return {};
  return {
    prompt_bytes_total: b.total,
    prompt_bytes_base: b.base,
    prompt_bytes_memory: b.memory,
    prompt_bytes_recent: b.recent,
    prompt_bytes_tool_output: b.tool_output,
    prompt_bytes_caller_impact: b.caller_impact,
    prompt_bytes_reverse_deps: b.reverse_deps,
    prompt_bytes_anti_examples: b.anti_examples,
  };
}

/**
 * Cap for the user's own words on the telemetry ROW.
 *
 * `captureIntent` leaves `user_raw_query` uncapped, which is fine for the v2
 * sidecar (one file per critique, read one at a time) and not fine here: this
 * log is append-only, `critic-event-log-window.ts` reads it WHOLE before
 * windowing, and nothing rotates it. The agent reply arrives already capped at
 * 1200 by `captureIntent`; this cap is the query's.
 *
 * **The size argument, with the size** (snapshot
 * `scripts/probes/critic-audit-coverage-probe-output-2026-08-19T19Z.txt` §5):
 * the live log is 37.3 MB over 34 902 rows, ~1120 bytes/row. These two fields
 * add up to 3200 bytes to a FIRED row — so on the fired rows they land on,
 * they can be several times the row's whole current footprint. Capping bounds
 * the per-row worst case; it does not bound the file, and the file has no
 * rotation. That is a known, unaddressed problem this change makes arrive
 * sooner, stated rather than implied by the word "capped".
 */
const MAX_ROW_QUERY_CHARS = 2000;

/**
 * The user's own words, written onto the telemetry ROW.
 *
 * Until 2026-08-19 these lived ONLY in the v2 sidecar, which is written only
 * when a critique is filed — 19 of the 400 most recent fired reviews on a
 * measured store, 4.8% (snapshot
 * `scripts/probes/critic-audit-coverage-probe-output-2026-08-19T19Z.txt` §4).
 * Block A's "what I read" therefore said "not captured" on the other 95.3%,
 * and unlike the changed files (which the row's `diff_summary` carries on
 * 93.4% of those rows) there was no second source to fall back to: the data
 * was genuinely never written. Writing it here is the fix; the renderer change
 * alone could not be one.
 *
 * Rows written before this change stay as they are — those prompts were not
 * recorded anywhere and cannot be backfilled.
 *
 * Truncation rides its OWN field rather than being marked inside the text.
 * A "… (truncated)" suffix inside a field labelled *verbatim* on the page
 * would be words the user never typed, which is the same defect as
 * `diff_summary.truncated` being kept out of `risks`.
 */
function capturedIntentFields(r: RunCriticResult): Record<string, string | boolean> {
  const ci = "capturedIntent" in r ? r.capturedIntent : undefined;
  if (!ci) return {};
  const out: Record<string, string | boolean> = {};
  if (ci.user_raw_query !== null) {
    out.user_raw_query = ci.user_raw_query.slice(0, MAX_ROW_QUERY_CHARS);
    if (ci.user_raw_query.length > MAX_ROW_QUERY_CHARS) out.user_raw_query_truncated = true;
  }
  if (ci.agent_reply !== null) out.agent_reply = ci.agent_reply;
  return out;
}

/**
 * Builder family (Slice B, T4) for the persisted row — WHICH CLI host built
 * this run, read from brain-config's authorFamily (SILTPOKE_HOST-derived).
 * Sync + fail-soft (any load error ⇒ "claude", same historical default as the
 * provider field), and only ever called on a fired/skip write path (one row
 * per hook), so the extra config read is negligible.
 */
function authorFamilyFor(home: string): string {
  try {
    return loadBrainConfigSync(home).authorFamily;
  } catch {
    return "claude";
  }
}

export interface HandleStopHookOptions {
  env?: NodeJS.ProcessEnv;
  brainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  /**
   * @internal test seam for dependency injection — do not set in production.
   * Allows unit tests to stub runTools / callBrain / writeCritique inside runCritic.
   */
  m112Deps?: RunCriticDeps;
  /**
   * @internal test seam — stub consolidate() in handle-stop tests.
   * Do not set in production.
   */
  consolidateFn?: typeof consolidate;
  /**
   * @internal test seam — menu-bar-pet T1. Stub git-branch resolution so
   * tests don't shell out. Production default shells `git rev-parse
   * --abbrev-ref HEAD` in the session cwd (see captureBranch below).
   */
  gitBranch?: (cwd: string) => string | null;
  /**
   * @internal test seam — menu-bar-pet T5. Stub the SwiftBar-refresh /
   * desktop-notification side effects so tests never shell out to
   * `open`/`osascript`. Production default (undefined) lets
   * menubar-refresh.ts resolve the real platform + spawnSync.
   */
  menubarDeps?: MenubarSideEffectDeps;
}

/**
 * Menu-bar-pet T1 — git branch captured at review time for fired brain-call
 * rows. Guarded: non-git dirs, detached HEAD, and any spawn failure all
 * resolve to null rather than throwing (logger failures must never crash
 * the hook, same discipline as appendJsonLine).
 */
export function defaultCaptureBranch(cwd: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
    });
    const b = r.status === 0 ? r.stdout.trim() : "";
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

function captureBranch(
  cwd: string,
  gitBranch: (cwd: string) => string | null = defaultCaptureBranch,
): string | null {
  try {
    return gitBranch(cwd);
  } catch {
    return null;
  }
}

/**
 * Slice ④ task 3 — map the generic `event.siltpoke_host` (stamped by the
 * per-host Stop normalizers — agy-stop.ts / codex-stop.ts; left undefined by
 * the native claude-code payload, which never sets it) onto the narrower
 * WhyHost union `maybeRecordWhy` expects. handleStopHook is the single
 * shared call site reached by ALL three hosts (native invokes it directly
 * via on-stop.ts, codex via runHook, agy via its detached on-stop.ts child —
 * see on-stop.ts's runHook), so this reads the real per-event host rather
 * than assuming "claude-code".
 */
export function resolveWhyHost(siltpokeHost: string | undefined): WhyHost {
  if (siltpokeHost === "codex" || siltpokeHost === "antigravity" || siltpokeHost === "codebuddy") {
    return siltpokeHost;
  }
  return "claude-code";
}

/**
 * Shared "pet fell asleep" state writer for the quiet-hours and
 * budget-hard-stop gates. Extracted from a closure inside handleStopHook so
 * both gates can call it without capturing handleStopHook's local scope.
 */
async function writeSleepingState(
  stateBase: string,
  event: HookEvent,
  mood: "sleeping_quiet" | "sleeping_broke",
): Promise<void> {
  try {
    await writeState(stateBase, {
      schemaVersion: 1,
      mood,
      pose: "base",
      bubble_short: "",
      severity: "info",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: event.session_id!,
    });
  } catch {
    // never crash hook
  }
}

// ---------------------------------------------------------------------------
// Pre-Brain-call gates. Each returns true when the hook should stop
// immediately (the gate already wrote its own telemetry/state side effects);
// false means "continue to the next gate". Order matches the original
// inline sequence in handleStopHook exactly.
// ---------------------------------------------------------------------------

async function checkFireGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const decision = shouldFire(event, env);
  if (!decision.fire) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: decision.reason,
    });
    return true;
  }
  return false;
}

async function checkMuteGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  now: Date,
): Promise<boolean> {
  // Mute beats wake. If the user ran /siltpoke-mute, short-circuit BEFORE
  // consuming the wake marker so an unused wake survives the mute window.
  // Mute is fail-open (missing/corrupt file = not muted).
  if (isMuted(homeBase, now)) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: "muted",
    });
    return true;
  }
  return false;
}

interface ReviewUnitGateResult {
  skip: boolean;
  /**
   * `<lastReviewedHead>..HEAD` — the unit of work that just closed. Threaded
   * down to git-diff so the reviewer is shown the unit rather than whatever
   * the diff tool guesses (spec D2). Absent on a forced review, which has no
   * unit to name.
   */
  revisionRange?: string;
  /**
   * Set only when this gate FIRED. Advancing the anchor consumes the HEAD
   * move: once it is on disk, this unit's diff can never appear in a later
   * `<anchor>..HEAD` range again. So on a fire it must not be written until
   * the review is actually going to be attempted — the caller invokes this
   * after the gates that sit BELOW this one have all passed.
   *
   * A non-fire decision writes its anchor immediately inside the gate and
   * leaves this undefined: nothing downstream can veto a skip, and an amend
   * whose anchor stays behind re-fires the same decision on every turn.
   */
  commitAnchor?: () => void;
}

/**
 * The review-unit gate (spec D1-D6) — the replacement for the trigger-mode
 * axis, which asked "did the agent stop talking" and, measured over 39,422
 * real triggers, blocked 2.
 *
 * This asks "has a unit of work closed": HEAD moved since the last review, and
 * the tree actually changed with it. Every exit names the rule that decided it
 * (D6 / AC9) — a gate that skips without saying why is the failure this whole
 * track exists to delete.
 *
 * Placed EARLY (D5), before the prompt assembly rather than after it. The old
 * code-change gate sat behind `buildPromptContext`, which meant the cheap
 * decision was paid for at the expensive one's price.
 */
async function checkReviewUnitGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  stateBase: string,
  wakeBypass: boolean,
  now: Date,
): Promise<ReviewUnitGateResult> {
  // `/siltpoke-review` and `/siltpoke-wake` mean "look now". They pre-date any
  // notion of a unit and must not be answered with "you have not committed":
  // the user asking IS the unit. No range, so git-diff keeps its old
  // working-tree behaviour and, on a clean tree, the recent-commits fallback.
  if (wakeBypass) return { skip: false };

  const unit = await loadReviewUnit(homeBase);

  // No cwd means no repo to ask about. `resolveHostCwd` has already run by
  // this point, so this is a genuinely degraded payload rather than a host
  // whose cwd merely needed recovering.
  if (event.cwd === undefined || event.cwd.length === 0) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: "not_a_git_repo",
      review_unit: unit,
    });
    return { skip: true };
  }

  const facts = await collectReviewUnitFacts({ cwd: event.cwd, stateBase, unit, now });
  const decision = decideReviewUnit(facts);

  // The anchor advances on every decision that CONSUMED the HEAD move —
  // `tree_unchanged` included. An amend that leaves the anchor behind re-fires
  // this decision on every turn forever.
  //
  // WHEN it is written depends on whether this gate fired, because writing it
  // is destructive: past the anchor, a unit's diff is unreachable forever.
  // A skip is final here, so it writes now. A fire is not — `checkCodeChangeGate`
  // runs next and decides from a completely different signal (which files the
  // session TRANSCRIPT shows Edit/Write touching), so it can veto a HEAD move
  // git can see perfectly well: `git merge`, `git cherry-pick`, or any commit
  // made outside the agent's own tool calls. Writing the anchor before that
  // veto is what made such a commit skipped once and then invisible to every
  // later range. So on a fire the write is handed back to the caller.
  const advanceTo = decision.advanceAnchorTo;
  const writeAnchorNow = (): void => {
    if (advanceTo === undefined) return;
    writeAnchor(stateBase, {
      head: advanceTo.head,
      tree: advanceTo.tree,
      reviewedAt: now.toISOString(),
    });
  };
  if (!decision.fire) writeAnchorNow();

  if (!decision.fire) {
    // S6 / AC13 — the quiet-path nudge. A lot of uncommitted work and no review
    // for a while: the pet says so instead of sitting there looking dead.
    //
    // ZERO Brain calls, and that is structural rather than a promise: this
    // branch writes a fixed string to state.json and returns. There is no
    // provider, no prompt assembly, and no await on anything that could reach
    // one. The thresholds behind `decision.nudge` are two named constants in
    // `review-unit.ts` (NUDGE_UNCOMMITTED_LINES / NUDGE_QUIET_MINUTES) and both
    // are declared guesses — a measurement moves them in one place.
    //
    // The row records that it happened so AC13's "zero Brain calls" is provable
    // from telemetry: a `nudged: true` row with a `skipped:` reason and no
    // corresponding brain call is the evidence, and reading the code is not.
    // A guard the first version did not have. The nudge overwrote `state.json`
    // unconditionally and on EVERY qualifying turn — so a real critique's
    // bubble, findings the user had not opened the dashboard to read yet, was
    // replaced by a generic "I have not looked at anything in a while", which
    // is also misleading right after a review just ran. The neighbouring
    // first-touch welcome already guards itself this way; this did not.
    //
    // The bubble is only replaced once the one on screen has itself gone quiet
    // for the same interval the nudge waits for. That both protects an unread
    // critique and stops the nudge repeating every turn forever.
    let nudged = false;
    const existing = await readState(stateBase);
    const bubbleAgeMinutes =
      existing === null ? Number.POSITIVE_INFINITY
        : (now.getTime() - (existing.last_updated_ms ?? 0)) / 60_000;
    if (decision.nudge === true && bubbleAgeMinutes > NUDGE_QUIET_MINUTES) {
      nudged = true;
      await writeState(stateBase, {
        schemaVersion: 1,
        mood: "curious",
        pose: "base",
        bubble_short:
          "You have a pile of uncommitted work and I have not looked at anything in a while.",
        severity: "info",
        confidence: "high",
        last_updated_ms: now.getTime(),
        last_session_id: event.session_id ?? "",
      });
    }

    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: decision.reason,
      review_unit: unit,
      // Only present when it fired — an unconditional `false` on every skip row
      // would make the nudge look like a thing that is constantly not happening
      // rather than a thing that occasionally does.
      nudged: nudged ? true : undefined,
    });
    return { skip: true };
  }

  // AC6 — `pr` was configured but there was no branch to diff, so this turn is
  // being reviewed as a commit instead. The degradation is written down rather
  // than left silent: the difference between a limitation and a lie is whether
  // the ledger says it happened.
  //
  // `review_unit_note` rather than `skipped`, because nothing was skipped — and
  // NOT a bare extra row either: `baseline.ts` counts any row without `skipped`
  // as a fire, so a marker-less informational row would inflate the very
  // BEFORE/AFTER comparison this axis is measured by. The harness knows this
  // key by name.
  if (decision.reason === "pr_fallback_to_commit") {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      review_unit: unit,
      review_unit_note: decision.reason,
    });
  }

  return { skip: false, revisionRange: decision.revisionRange, commitAnchor: writeAnchorNow };
}

async function checkBreakerGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  now: Date,
  wakeBypass: boolean,
): Promise<boolean> {
  // Brain circuit breaker — while open, skip the spawn entirely and write a
  // telemetry skip record. /siltpoke-wake clears the breaker (the user's
  // explicit "try now"); this is also the self-serve clear for a latched
  // permanent class.
  const health = readBrainHealth(homeBase);
  if (wakeBypass) {
    if (health.breaker !== null) {
      // Wake = "try now", not "declare healthy": clearBreaker leaves
      // consecutive_failures intact, so the next failure reopens the
      // breaker at the escalated window.
      writeBrainHealth(homeBase, clearBreaker(health));
    }
  } else {
    const breaker = isBreakerOpen(health, now);
    if (breaker.open) {
      await appendJsonLine(env, {
        timestamp: now.toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        skipped: "brain_breaker_open",
        breaker_class: health.breaker?.class,
        breaker_reason: breaker.reason,
        next_eligible_at: health.breaker?.next_eligible_at,
      });
      return true;
    }
  }
  return false;
}

async function checkQuietHoursGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  now: Date,
  wakeBypass: boolean,
  stateBase: string,
): Promise<boolean> {
  // Quiet hours. Bypass skips this gate.
  if (!wakeBypass) {
    const quietConfig = await loadQuietHoursConfig(homeBase);
    if (isQuietHour(now, quietConfig)) {
      await writeSleepingState(stateBase, event, "sleeping_quiet");
      await appendJsonLine(env, {
        timestamp: now.toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        skipped: "quiet_hours",
        mood: "sleeping_quiet",
      });
      return true;
    }
  }
  return false;
}

async function checkBudgetGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  now: Date,
  wakeBypass: boolean,
  stateBase: string,
  budgetConfig: BudgetConfig,
): Promise<boolean> {
  // Budget gate. Bypass skips this gate.
  if (!wakeBypass) {
    const rollup = await loadDailyRollup(homeBase, now, budgetConfig.resetAtMinutes);
    const budget = evaluateBudget(rollup, budgetConfig);
    if (budget.stage === "hard") {
      await writeSleepingState(stateBase, event, "sleeping_broke");
      await appendJsonLine(env, {
        timestamp: now.toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        skipped: "budget_hard_stop",
        used_pct: budget.used_pct,
        mood: "sleeping_broke",
      });
      return true;
    }
    if (budget.stage === "soft") {
      // Soft budget: degrade to on_demand for this call. Since wakeBypass is
      // false here, we short-circuit.
      await appendJsonLine(env, {
        timestamp: now.toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        skipped: "soft_budget_on_demand",
        degraded: "on_demand_soft",
        used_pct: budget.used_pct,
      });
      return true;
    }
  }
  return false;
}

async function checkCodeChangeGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  stateBase: string,
  wakeBypass: boolean,
  changedFiles: string[],
): Promise<boolean> {
  // Code-change gate. Brain reviews code, not chit-chat.
  // If the turn touched no files, skip the brain call entirely. The
  // /siltpoke-review and /siltpoke-wake bypasses still work because they
  // set wakeBypass earlier in the flow.
  if (!wakeBypass && changedFiles.length === 0) {
    // First-touch acknowledgement (sq-nocode-noop, day-1). On a brand-new
    // install the very first Stop often carries no code changes — the user
    // just chatted or explored. Returning silently left the pet inert on
    // first contact, which reads as "broken / did nothing". If the pet has
    // never written state anywhere yet, write a one-time ambient welcome so
    // it visibly acknowledges it's watching. Once any state exists (a prior
    // critique, or a /siltpoke-pet tick), steady-state no-code turns stay
    // silent — no nag on every chat turn.
    const neverReacted =
      !existsSync(join(stateBase, "state.json")) &&
      !existsSync(join(homeBase, "state.json"));
    if (neverReacted) {
      await writeState(stateBase, {
        schemaVersion: 1,
        mood: "happy",
        pose: "base",
        bubble_short:
          "👋 I'm watching your Claude Code sessions — I'll speak up when code changes.",
        severity: "info",
        confidence: "high",
        last_updated_ms: Date.now(),
        last_session_id: event.session_id!,
      });
    }
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: "no_code_changes",
      changed_files_count: 0,
      first_touch_welcome: neverReacted ? true : undefined,
    });
    return true;
  }

  // The docs gate (D7 / AC7). Deliberately a second branch of THIS gate rather
  // than a gate of its own: this one already has the paths and, until now, threw
  // them away after a `.length` check.
  //
  // A separate reason from `no_code_changes` on purpose — AC9 asks which rule
  // decided, and "you changed nothing" and "you changed only prose" are
  // different answers. `changed_files_count` is carried so the row is not
  // mistakable for the empty case, and the classified paths go in the row too:
  // a wrong classification is invisible without them, and D7's own risk (R3) is
  // that the classification is wrong.
  if (!wakeBypass && !anyCodeChanged(changedFiles)) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: "docs_only",
      changed_files_count: changedFiles.length,
      docs_only_files: changedFiles.slice(0, 20),
    });
    return true;
  }
  return false;
}

interface DedupeGateResult {
  skip: boolean;
  hash: string;
}

async function checkDedupeGate(
  event: HookEvent,
  env: NodeJS.ProcessEnv,
  homeBase: string,
  changedFiles: string[],
  latestUserMessage: string,
): Promise<DedupeGateResult> {
  const signature = buildSignature({
    sessionId: event.session_id!,
    cwd: event.cwd ?? "",
    changedFiles,
    latestUserMessage,
  });
  const skipDecision = await evaluateSkip({
    basePath: homeBase,
    sessionId: event.session_id!,
    signature,
  });
  if (skipDecision.skip) {
    await commitHash(homeBase, event.session_id!, skipDecision.hash);
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: "no_change",
      context_hash: skipDecision.hash,
      changed_files_count: changedFiles.length,
    });
  }
  return { skip: skipDecision.skip, hash: skipDecision.hash };
}

export interface PromptContext {
  personalitySystemPrompt: string;
  memory: CoreMemory | null;
  recent: RecentEntry[];
  systemPrompt: string;
  memoryRulesCount: number;
  /** Read-half funnel for the legacy path's telemetry row (eval design §2.1). */
  memoryFunnel: MemoryFunnel;
  recentEntriesCount: number;
  /**
   * Anti-examples block (few-shot retrieval over past dismissed critiques).
   * Already folded into `systemPrompt` above for the legacy path's own
   * `assembleSystemPromptWithFunnel` call; returned separately here too so the
   * tool-augmented (default) path — which assembles its OWN prompt inside
   * `runNormalPhase` / `runPassiveBubblePhase` — can thread it through
   * `BrainContext.antiExamplesBlock` instead of losing it. "" when there is
   * nothing to inject or when computing it failed (fail-soft, see below).
   */
  antiExamplesBlock: string;
}

/**
 * Length cap applied to the diff-bundle text before it is embedded for
 * anti-examples retrieval (Task B critical #3). The full bundle can run to
 * many hundreds of KB on a large diff; retrieval only needs enough text to
 * characterize "what is this review about", so embedding the whole thing on
 * every turn buys nothing but embedding cost. 8KB comfortably covers a
 * multi-file diff's worth of signal without paying to embed a huge one.
 */
const ANTI_EXAMPLES_QUERY_MAX_CHARS = 8_000;

/**
 * Assembles the personality + memory + rules system prompt used by both the
 * tool-augmented and legacy Brain paths.
 *
 * Exported (not just for internal use) so `tests/hooks/anti-examples-wiring.test.ts`
 * can exercise the real wiring point directly — this function reads real fs
 * state off `homeBase`, so a test seeding a temp `homeBase` with a
 * `few-shot-index.json` exercises the actual seam rather than a mock echoing
 * itself.
 */
export async function buildPromptContext(
  homeBase: string,
  event: HookEvent,
  bundleText: string,
  costConfig: CostConfig,
): Promise<PromptContext> {
  const personality = await loadPersonality(homeBase);
  // Facts + learned rules live in the canonical V3 store (homeBase); V3 does
  // per-project scoping internally (resolveProjectRoot(event.cwd)). event.cwd
  // (the repo that fired THIS Stop event) is threaded explicitly because the
  // daemon's own process.cwd() is frozen at daemon-launch time and would
  // otherwise leak one repo's memory slice into every other repo sharing the
  // daemon. Falls back to process.cwd() when event.cwd is absent (matches
  // pre-fix behavior). The old per-repo stateBase predates V3 and reads an
  // empty legacy store.
  const memory = await readMemory(homeBase, event.cwd || undefined);
  const personalitySystemPrompt = await buildSystemPrompt(
    personality,
    undefined,
    memory?.personality_drift ?? null,
  );
  const recentPath = resolveRecentPath(event.cwd, homeBase);
  const recent = await readRecent(recentPath);
  const fileTypes = detectFileTypes(bundleText);
  // queryText = bundleText (the diff bundle under review): at assembly time
  // this review's own critique doesn't exist yet (Brain hasn't run), so the
  // diff being reviewed is the best available proxy for "what will this
  // critique be about" — index entries are themselves built from past
  // dismissed critiques' reason_text + critique_snapshot (see
  // buildFewShotIndex in src/few-shot/build-index.ts), which in practice
  // echo the code pattern that triggered them (e.g. "any" usage, null
  // checks), so retrieval on the current diff text recalls semantically
  // similar past dismissals. indexPath is threaded off homeBase (not the
  // few-shot module's own DEFAULT_PATH) for the same reason readMemory/
  // loadPersonality thread it explicitly above — the daemon's process.cwd()
  // is frozen at launch and a bare default would silently read the wrong
  // SILTPOKE_HOME under an override.
  // Fail-soft (Task B critical #2): buildAntiExamplesBlock runs on EVERY turn,
  // and its embedder (.embed(), src/few-shot/embedder.ts) is not guarded — a
  // missing/corrupt index or an embedding failure must never abort the whole
  // Stop-hook review the way an unwrapped throw here would. Mirrors
  // buildCallerImpactSection's "empty on any error" discipline
  // (src/critic/phases/normal.ts).
  let antiExamplesBlock = "";
  try {
    antiExamplesBlock = await buildAntiExamplesBlock(
      bundleText.slice(0, ANTI_EXAMPLES_QUERY_MAX_CHARS),
      3,
      { indexPath: join(homeBase, "few-shot-index.json") },
    );
  } catch (err) {
    console.error("[siltpoke] buildAntiExamplesBlock threw, degrading to no anti-examples:", err);
  }
  const { prompt: systemPrompt, funnel: memoryFunnel } = assembleSystemPromptWithFunnel({
    personalitySystemPrompt,
    memory,
    recent,
    fileTypes,
    maxRules: costConfig.maxRules,
    recentInjectionCount: costConfig.recentInjectionCount,
    antiExamplesBlock,
  });
  const memoryRulesCount = memory
    ? memory.learned_rules.filter((r) => r.effectiveness !== "retired").length
    : 0;
  const recentEntriesCount = recent.length;

  return {
    personalitySystemPrompt,
    memory,
    recent,
    systemPrompt,
    memoryRulesCount,
    memoryFunnel,
    recentEntriesCount,
    antiExamplesBlock,
  };
}

/**
 * Task 14 — latent hardening. `event.cwd` is required in practice: every
 * live Stop-hook payload carries it. Under launchd the daemon's own
 * `process.cwd()` is frozen at daemon-launch time (NOT the repo under
 * review) — a payload that omitted `cwd` would make every downstream
 * `event.cwd ?? process.cwd()` fallback (packContext, memory lookup, branch
 * capture, project capabilities, git baseline, sweepPending, ...) AND the
 * `stateBase` homeBase fallback silently operate on the wrong directory.
 * Called ONCE, unconditionally, as the very first thing in
 * handleStopHook — deliberately BEFORE any gate (fire/mute/trigger/
 * breaker/quiet-hours/budget) can short-circuit with an early `return`, so
 * a missing `cwd` is always surfaced regardless of which path the event
 * takes afterward. Warning once per invocation here (rather than once per
 * fallback call site below) avoids spamming the log 5-9x for one event.
 */
function warnIfEventCwdAbsent(event: HookEvent): void {
  if (!event.cwd) {
    console.error(
      "[siltpoke] event.cwd absent — falling back to process.cwd() for this Stop-hook invocation; review may target the wrong directory",
    );
  }
}

export async function handleStopHook(
  event: HookEvent,
  opts?: HandleStopHookOptions,
): Promise<void> {
  warnIfEventCwdAbsent(event);

  const env = opts?.env ?? process.env;
  const consolidateFn = opts?.consolidateFn ?? consolidate;

  if (await checkFireGate(event, env)) return;

  const homeBase = siltpokeRoot(env);
  const now = new Date();

  if (await checkMuteGate(event, env, homeBase, now)) return;

  // Consume any pending /siltpoke-wake bypass; the file is deleted whether
  // or not the timestamp is still fresh (one-shot).
  const wakeBypass = await consumeWake(homeBase, now);

  if (await checkBreakerGate(event, env, homeBase, now, wakeBypass)) return;

  // pruneMissing: drop transcript paths renamed/deleted later in the session so
  // the critic doesn't flag files that no longer exist (e.g. a kebab-case rename).
  //
  // NOT confineToCwd here. `event.cwd` is not yet trustworthy at this point —
  // the re-anchor below exists precisely because agy `-p` sends no
  // workspacePaths and cwd falls back to agy's own config dir — and
  // `resolveHostCwd` recovers the real repo FROM this list. Filtering against
  // an untrusted cwd to then derive the trusted one is circular, and it breaks
  // concretely: every path resolves outside, the all-dropped fail-safe returns
  // the list unfiltered anyway, and `resolveHostCwd` anchors on the
  // lexicographically first absolute path (`unionPaths` sorts) — which for a
  // repo under ~/Projects is a `~/.claude/.../memory/*.md` write, not the code.
  // Confinement happens right after the re-anchor, against the corrected cwd.
  //
  // Measured honesty: moving the confinement here is NOT what makes the agy
  // case pass — `resolveHostCwd`'s anchor selection is. A mutation that puts
  // the filter back in front of the re-anchor leaves every test green, because
  // either the all-dropped fail-safe hands the list back whole, or something
  // survived inside the payload cwd and `resolveHostCwd` short-circuits on
  // `cwdContains` anyway. This ordering is kept as defence in depth against a
  // future change to that short-circuit, not because a test distinguishes it.
  const changedFilesUnconfined = await extractChangedFiles(event.transcript_path!, {
    cwd: event.cwd,
    pruneMissing: true,
  });

  // Re-anchor the review cwd for a degraded-payload host (agy `-p` has no
  // workspacePaths → cwd fell back to agy's config dir). This MUST run before
  // stateBase / packContext / buildPromptContext below: every one of them reads
  // event.cwd, so a late fix would repair only the critic's tools while leaving
  // pet state, the pending-critique queue, memory/recent scoping, and
  // consolidation all pointed at the wrong directory (the very "pet silently
  // does nothing" symptom this fixes). The transcript's absolute changed-file
  // paths are correct regardless of cwd, so point everything at their git root.
  // No-op for every other host and for interactive agy (cwd already correct).
  const reviewCwd = resolveHostCwd({
    host: event.siltpoke_host,
    payloadCwd: event.cwd,
    changedFiles: changedFilesUnconfined,
  });
  if (reviewCwd && reviewCwd !== event.cwd) {
    event.cwd = reviewCwd;
  }

  // NOW confine — cwd is settled. Drops paths outside the repo entirely: /tmp
  // build logs, scratchpad scripts, /dev/null, `~/.claude/.../memory/*.md`.
  // They are real files the session really wrote, so pruneMissing keeps them,
  // and everything downstream then treats them as reviewable source: the
  // code-change gate counts them as "this turn touched code", the dedupe
  // signature keys on them, and the rubric reviews them (a 9915-line /tmp build
  // log tripping god-file is how critique c-193a got its anchors[0]).
  const changedFiles =
    event.cwd && event.cwd.length > 0
      ? confineToRepo(changedFilesUnconfined, event.cwd)
      : changedFilesUnconfined;

  const stateBase =
    event.cwd && event.cwd.length > 0
      ? join(event.cwd, ".siltpoke")
      : homeBase;

  if (await checkQuietHoursGate(event, env, homeBase, now, wakeBypass, stateBase)) {
    return;
  }

  const budgetConfig = await loadBudgetConfig(homeBase);
  if (
    await checkBudgetGate(event, env, homeBase, now, wakeBypass, stateBase, budgetConfig)
  ) {
    return;
  }

  // ⏱ review-unit gate (spec D5) — the cheap decision, placed before the
  // expensive assembly rather than behind it. Order here is
  // quiet-hours → budget → review-unit → code-change/docs → buildPromptContext.
  const reviewUnitGate = await checkReviewUnitGate(
    event, env, homeBase, stateBase, wakeBypass, now,
  );
  if (reviewUnitGate.skip) return;

  // Moved up with it, for the same reason: this gate skipped 8,342 turns in the
  // measured corpus and every one of them had already paid for packContext +
  // buildPromptContext before saying "no code changed".
  if (
    await checkCodeChangeGate(event, env, homeBase, stateBase, wakeBypass, changedFiles)
  ) {
    return;
  }

  // The review is going to be attempted, so the unit may now be consumed. This
  // is deliberately AFTER the code-change gate and BEFORE the dedupe gate: a
  // code-change skip means this unit was never looked at, while a dedupe skip
  // means it was already said. Only the first of those must be retryable.
  reviewUnitGate.commitAnchor?.();

  const costConfig = await loadCostConfig(homeBase);
  // Forward-capture case1-freeze gate (Task 8) — read once per hook, threaded
  // to both enqueue sites below. Opt-in, default OFF (see
  // src/config/case1-capture-config.ts).
  const case1CaptureConfig = await loadCase1CaptureConfig(homeBase);

  const bundle = await packContext({
    session_id: event.session_id!,
    cwd: event.cwd ?? process.cwd(),
    transcript_path: event.transcript_path!,
    maxTurns: costConfig.maxTranscriptTurns,
  });

  const {
    personalitySystemPrompt,
    memory,
    recent,
    systemPrompt,
    memoryRulesCount,
    memoryFunnel,
    recentEntriesCount,
    antiExamplesBlock,
  } = await buildPromptContext(homeBase, event, bundle.text, costConfig);

  const latestUserMessage = await extractLatestUserMessage(
    event.transcript_path!,
  );

  const dedupe = await checkDedupeGate(event, env, homeBase, changedFiles, latestUserMessage);
  if (dedupe.skip) return;
  const contextHash = dedupe.hash;

  const t0 = Date.now();

  // ---------------------------------------------------------------------------
  // Tool-augmented critic path.
  // Now ON by default. Opt-out with SILTPOKE_TOOL_AUGMENTED=0 to fall
  // through to the legacy inline Brain call. Without this path
  // Brain never sees git-diff / tsc / eslint findings — which is the entire
  // point of this work, so opt-out only makes sense for debugging.
  // ---------------------------------------------------------------------------
  const m112Enabled = env.SILTPOKE_TOOL_AUGMENTED !== "0";

  if (m112Enabled) {
    await runToolAugmentedPath({
      event,
      env,
      opts,
      homeBase,
      stateBase,
      now,
      t0,
      contextHash,
      bundleText: bundle.text,
      personalitySystemPrompt,
      memory,
      recent,
      costConfig,
      consolidateFn,
      antiExamplesBlock,
      case1CaptureConfig,
      revisionRange: reviewUnitGate.revisionRange,
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Legacy baseline path — preserved when SILTPOKE_TOOL_AUGMENTED is OFF.
  // ---------------------------------------------------------------------------
  await runLegacyPath({
    event,
    env,
    opts,
    homeBase,
    stateBase,
    t0,
    contextHash,
    systemPrompt,
    bundle,
    memoryRulesCount,
    memoryFunnel,
    recentEntriesCount,
    consolidateFn,
    case1CaptureConfig,
  });
}

/**
 * Disk-first baseline — read HEAD SHA captured at session start. The
 * persisted baseline.json is written by the SessionStart hook and contains
 * the HEAD SHA before any commits during this session. We read it here as a
 * fallback hint; the git-status GitBaseline (entries map) still comes from
 * captureGitBaseline() for change-file detection. When the SessionStart hook
 * was not installed (no baseline.json) or the session_id doesn't match, we
 * fall through to captureGitBaseline() as before.
 */
export function resolveSessionHeadSha(sessionCwd: string, sessionId: string): string | null {
  // Per-session record first, legacy single slot as fallback — see
  // session-baseline.ts for why the single slot alone could not work once two
  // sessions shared a checkout.
  return readSessionBaseline(sessionCwd, sessionId)?.head_sha ?? null;
}

interface TracerBundle {
  tracer: Tracer | undefined;
  traceStore: TraceStore | undefined;
}

/**
 * OTEL tracer + store: construct lazily so each Stop hook produces its own
 * root span tree. Fail-soft — if construction throws (missing directory,
 * sqlite open error), proceed without tracing rather than blocking the
 * critic.
 */
async function buildTracerBundle(homeBase: string): Promise<TracerBundle> {
  try {
    const tracesDir = join(homeBase, "traces");
    const spilloverDir = join(tracesDir, "spillover");
    await mkdir(tracesDir, { recursive: true });
    await mkdir(spilloverDir, { recursive: true });
    const tracer = new Tracer({ spilloverDir });
    const traceStore = new TraceStore({
      dir: tracesDir,
      dbPath: join(tracesDir, "index.sqlite"),
    });
    return { tracer, traceStore };
  } catch {
    return { tracer: undefined, traceStore: undefined };
  }
}

interface XpAwardResult {
  xpAwarded: number;
  leveledUp: boolean;
}

/**
 * Shared XP-award logic — identical between the tool-augmented NORMAL/accepted
 * path and the legacy path (was duplicated verbatim in both before this
 * extraction).
 */
async function awardXpFromEvents(
  homeBase: string,
  xpEarnedEvents: BrainOutput["xp_earned_events"],
): Promise<XpAwardResult> {
  let xpAwarded = 0;
  let leveledUp = false;
  if (Array.isArray(xpEarnedEvents) && xpEarnedEvents.length > 0) {
    const totalXp = xpEarnedEvents.reduce(
      (sum, e) => sum + (typeof e.amount === "number" ? e.amount : 0),
      0,
    );
    if (totalXp > 0) {
      const current = await readProgression(homeBase);
      const result = addXp(current, totalXp);
      await writeProgression(homeBase, result.next);
      xpAwarded = result.delta;
      leveledUp = result.leveled_up;
    }
  }
  return { xpAwarded, leveledUp };
}

/**
 * Trigger consolidation cadence (hybrid). Shared between the tool-augmented
 * and legacy paths — was duplicated verbatim in both before this extraction.
 * projectBase = repo-local .siltpoke (stateBase); the critic writes
 * critiques project-local, so consolidate must read them from there.
 */
async function triggerConsolidation(
  consolidateFn: typeof consolidate,
  homeBase: string,
  stateBase: string,
  cwd: string | undefined,
): Promise<void> {
  try {
    const consolidateResult = await consolidateFn({
      homeBase,
      projectBase: stateBase,
      projectCwd: cwd,
    });
    if (consolidateResult.ran) {
      console.error(
        `[siltpoke memory] consolidated: +${consolidateResult.apply.added} active, ${consolidateResult.apply.skipped} bumped, discarded: ${consolidateResult.apply.discarded}, ${consolidateResult.prune.factsPruned + consolidateResult.prune.pendingPruned} pruned`,
      );
    }
  } catch (err) {
    console.error("[siltpoke memory] consolidate threw:", err);
    // do not propagate; consolidate failure should not crash the Stop hook
  }
}

type HardSuppressResult = Extract<RunCriticResult, { decision: "HARD_SUPPRESS" }>;
type PassiveBubbleResult = Extract<RunCriticResult, { decision: "PASSIVE_BUBBLE" }>;
type NormalAcceptedResult = Extract<RunCriticResult, { decision: "NORMAL"; accepted: true }>;

async function handleHardSuppress(
  criticResult: HardSuppressResult,
  env: NodeJS.ProcessEnv,
  event: HookEvent,
  t0: number,
): Promise<void> {
  // Quota-cap / agy-prompt-too-large skip (track #7 T4 / T4 fixup): an
  // honest skip-record row, like the sibling pre-spawn brakes
  // (brain_breaker_open / budget_hard_stop / quiet_hours /
  // recursion_guard) — NOT a generic HARD_SUPPRESS/m112_reason
  // free-text row. No usage event either: no call happened, $0 spent.
  // `skipped` carries the SPECIFIC code (not collapsed to one label)
  // so analytics can distinguish a daily-cap skip from an
  // argv-too-large abstain.
  if (
    criticResult.skipCode === "quota_cap" ||
    criticResult.skipCode === "agy_prompt_too_large"
  ) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      duration_ms: Date.now() - t0,
      skipped: criticResult.skipCode,
      ...providerFields(criticResult, authorFamilyFor(siltpokeRoot(env))),
      ...memoryFunnelFields(criticResult),
      ...promptBytesFields(criticResult),
      ...capturedIntentFields(criticResult),
    });
    return;
  }
  // HARD_SUPPRESS covers both a pre-assembly gate decision (no prompt was ever
  // built, so no funnel) and a suppression after the Brain call returned (a
  // prompt WAS built). memoryFunnelFields emits the columns only in the second
  // case, which is what keeps "never measured" readable as absence.
  await appendJsonLine(env, {
    timestamp: new Date().toISOString(),
    session_id: event.session_id,
    cwd: event.cwd,
    duration_ms: Date.now() - t0,
    m112_path: true,
    critic_path_decision: "HARD_SUPPRESS",
    m112_reason: criticResult.reason,
    diff_snapshot_id: criticResult.diffSnapshotId,
    diff_summary: "diffSummary" in criticResult ? criticResult.diffSummary : undefined,
    timing: criticResult.timing,
    summary_error: criticResult.summaryError,
    ...providerFields(criticResult, authorFamilyFor(siltpokeRoot(env))),
    ...memoryFunnelFields(criticResult),
    ...promptBytesFields(criticResult),
    ...capturedIntentFields(criticResult),
  });
}

interface PassiveBubbleCtx {
  env: NodeJS.ProcessEnv;
  event: HookEvent;
  t0: number;
  homeBase: string;
  stateBase: string;
  now: Date;
  opts: HandleStopHookOptions | undefined;
  branch: string | null;
}

async function handlePassiveBubble(
  criticResult: PassiveBubbleResult,
  ctx: PassiveBubbleCtx,
): Promise<void> {
  const { env, event, t0, homeBase, stateBase, now, opts, branch } = ctx;
  const out = criticResult.critique;
  const pf = providerFields(criticResult, authorFamilyFor(homeBase));
  // F4: record Brain tokens so the daily budget rollup stays accurate.
  await appendUsageEvent(homeBase, {
    ts: new Date().toISOString(),
    kind: "main",
    session_id: event.session_id!,
    input_tokens: criticResult.usage.input_tokens,
    output_tokens: criticResult.usage.output_tokens,
    cache_creation_input_tokens: criticResult.usage.cache_creation_input_tokens,
    cache_read_input_tokens: criticResult.usage.cache_read_input_tokens,
    total_cost_usd: criticResult.usage.total_cost_usd,
    ...pf,
  });
  // Empty effective bubble → skip the state/activity
  // write entirely; the jsonl telemetry line below is still written,
  // flagged so the history render layer filters the row.
  const passiveBubbleSuppressed = out.bubble_short.trim().length === 0;
  if (!passiveBubbleSuppressed) {
    try {
      await writeState(stateBase, {
        schemaVersion: 1,
        mood: out.mood,
        pose: out.pose,
        bubble_short: out.bubble_short,
        severity: out.severity,
        confidence: out.confidence,
        last_updated_ms: Date.now(),
        last_session_id: event.session_id!,
      });
    } catch {
      // non-fatal
    }
  }
  await appendJsonLine(env, {
    timestamp: new Date().toISOString(),
    session_id: event.session_id,
    cwd: event.cwd,
    duration_ms: Date.now() - t0,
    m112_path: true,
    critic_path_decision: "PASSIVE_BUBBLE",
    // Read off the result, NOT re-stated as a literal here. The first draft
    // hardcoded `"not_checked"` while `RunCriticResult` carried the same value
    // one field away, so the typed field had no reader and the literal had no
    // test — flipping it to any other label left the suite green. That is the
    // shape this very branch's journal entry is about; writing it twice is how
    // it happens.
    m112_evidence_label: criticResult.evidenceLabel,
    m112_evidence_unverified: 0,
    bubble_suppressed: passiveBubbleSuppressed ? true : undefined,
    critique_id: "critiqueId" in criticResult ? criticResult.critiqueId : undefined,
    branch,
    brain_output: out,
    // Rail/header cost+token readout parses `usage` off this line
    // (critic-event-log-parse) — without it every row reads $—/0 tok.
    usage: criticResult.usage,
    diff_snapshot_id: criticResult.diffSnapshotId,
    diff_summary: "diffSummary" in criticResult ? criticResult.diffSummary : undefined,
    timing: criticResult.timing,
    summary_error: criticResult.summaryError,
    ...pf,
    ...memoryFunnelFields(criticResult),
    ...promptBytesFields(criticResult),
    ...capturedIntentFields(criticResult),
  });
  // Fire-and-forget side effects on the fired write: re-render the
  // menu bar instantly, and (mute/platform-gated) pop a desktop
  // notification. Both are sync + internally guarded — never awaited,
  // never allowed to throw back into the hook.
  refreshMenubar(opts?.menubarDeps);
  if (!passiveBubbleSuppressed) {
    notifyReview(out.bubble_short, isMuted(homeBase, now), opts?.menubarDeps);
  }
}

/**
 * Everything `stampCase1Capture` needs to call `captureCase1Pre` at either
 * enqueue site, without depending on the enclosing function's full ctx shape.
 */
export interface StampCase1Ctx {
  critique_id: string;
  session_id: string;
  cwd: string;
  stateBase: string;
  finding_text: string;
  severity: string;
  /**
   * The FULL critique anchors — `tool` + `fingerprint` are REQUIRED here (both
   * enqueue sites have them: `pendingAnchorSchema` mandates them, and the
   * fingerprint is computed a few lines above from the full file). Requiring
   * them makes a narrowing `anchors.map((a) => ({ file: a.file }))` a typecheck
   * error rather than a silent loss of the flagged line — which is exactly what
   * used to gut `anchor_fingerprints` down to a whole-file hash set.
   */
  anchors: Array<{ file: string; line?: number; tool: string; fingerprint: string }>;
  evidenceFiles: string[];
  config: Case1CaptureConfig | null | undefined;
  env: NodeJS.ProcessEnv | undefined;
}

/**
 * Forward-capture Phase 1 wrapper (Task 8). Calls `captureCase1Pre` and
 * stamps the returned `capture_id` onto the `PendingCritique`; on `undefined`
 * (disabled / no safe files / any internal failure) OR if this wrapper itself
 * throws, returns the ORIGINAL entry unchanged. Enqueue must NEVER be
 * blocked, delayed, or altered by a capture failure — this function can
 * never throw.
 */
export async function stampCase1Capture(
  entry: PendingCritique,
  ctx: StampCase1Ctx,
  deps: CaptureDeps,
): Promise<PendingCritique> {
  try {
    const capture_id = await captureCase1Pre(
      {
        critique_id: ctx.critique_id,
        session_id: ctx.session_id,
        cwd: ctx.cwd,
        stateBase: ctx.stateBase,
        finding_text: ctx.finding_text,
        severity: ctx.severity,
        anchors: ctx.anchors,
        evidenceFiles: ctx.evidenceFiles,
      },
      ctx.config,
      ctx.env,
      deps,
    );
    if (capture_id === undefined) return entry;
    return { ...entry, capture_id };
  } catch {
    return entry;
  }
}

interface NormalAcceptedCtx {
  env: NodeJS.ProcessEnv;
  event: HookEvent;
  t0: number;
  homeBase: string;
  stateBase: string;
  now: Date;
  opts: HandleStopHookOptions | undefined;
  branch: string | null;
  /** Session-start baseline SHA (Build-2 pending-critique provenance). */
  sessionHeadSha: string | null;
  /** Forward-capture case1-freeze gate (Task 8) — read from disk once per hook. */
  case1CaptureConfig: Case1CaptureConfig;
}

async function handleNormalAccepted(
  criticResult: NormalAcceptedResult,
  out: BrainOutput,
  pf: ProviderFields,
  ctx: NormalAcceptedCtx,
): Promise<void> {
  const { env, event, t0, homeBase, stateBase, now, opts, branch, sessionHeadSha, case1CaptureConfig } = ctx;
  const critiqueId = "critiqueId" in criticResult ? criticResult.critiqueId : undefined;

  // Build-2 enqueue: park a pending critique for deferred acted-on
  // adjudication by a later sweep. This is the LIVE tool-augmented
  // critic path's write site (NORMAL/accepted, the common case) — guarded
  // end-to-end, must never break the Stop-hook review.
  try {
    if (critiqueId && out.evidence.length > 0) {
      const sessionCwd = event.cwd ?? process.cwd();
      const contentCache = new Map<string, string>();
      const readOnce = async (f: string): Promise<string> => {
        if (contentCache.has(f)) return contentCache.get(f)!;
        let text = "";
        try {
          text = await readFile(join(sessionCwd, f), "utf8");
        } catch {
          text = "";
        }
        contentCache.set(f, text);
        return text;
      };
      const anchors = [];
      for (const e of out.evidence) {
        const content = await readOnce(e.file);
        anchors.push({
          file: e.file,
          line: e.line,
          tool: e.tool,
          fingerprint: content ? lineContentFingerprint(content, e.line ?? 0) : "",
        });
      }
      const baseEntry = pendingCritiqueSchema.parse({
        critique_id: critiqueId,
        session_id: event.session_id!,
        created_sha: sessionHeadSha ?? null,
        created_at: new Date().toISOString(),
        hooks_elapsed: 0,
        status: "pending",
        severity: out.severity,
        finding_text: out.critique_for_claude,
        anchors,
      });
      // Forward-capture Phase 1 (Task 8) — opt-in, default OFF; a failure
      // here must never block or alter the enqueue below.
      const entry = await stampCase1Capture(
        baseEntry,
        {
          critique_id: critiqueId,
          session_id: event.session_id!,
          cwd: sessionCwd,
          stateBase,
          finding_text: out.critique_for_claude,
          severity: out.severity,
          anchors,
          evidenceFiles: out.evidence.map((e) => e.file),
          config: case1CaptureConfig,
          env,
        },
        nodeCaptureDeps,
      );
      await enqueuePending(pendingQueuePath(stateBase), entry);
    }
  } catch {
    // Build-2 enqueue must never break the review.
  }

  // NORMAL accepted — write state, handle XP, log
  let stateError: string | undefined;

  // Low-confidence blanking used to write an EMPTY bubble
  // row; now an empty effective bubble skips the state write entirely
  // (jsonl telemetry below still written, flagged for the render filter).
  const normalEffectiveBubble =
    out.confidence !== "low" ? out.bubble_short : "";
  const normalBubbleSuppressed = normalEffectiveBubble.trim().length === 0;
  if (!normalBubbleSuppressed) {
    try {
      await writeState(stateBase, {
        schemaVersion: 1,
        mood: out.mood,
        pose: out.pose,
        bubble_short: normalEffectiveBubble,
        severity: out.severity,
        confidence: out.confidence,
        last_updated_ms: Date.now(),
        last_session_id: event.session_id!,
      });
    } catch (err) {
      stateError = String(err);
    }
  }

  const { xpAwarded, leveledUp } = await awardXpFromEvents(homeBase, out.xp_earned_events);

  await appendJsonLine(env, {
    timestamp: new Date().toISOString(),
    session_id: event.session_id,
    cwd: event.cwd,
    duration_ms: Date.now() - t0,
    m112_path: true,
    critic_path_decision: "NORMAL",
    m112_accepted: true,
    // How much of this review's evidence was confirmed. Written on the
    // ACCEPTED row on purpose: since the evidence check stopped discarding
    // reviews, "the reviewer cited nothing" and "one citation could not be
    // confirmed" are properties of a review the user is looking at, not
    // reasons it is missing. Without these two fields the timeline would show
    // an unverified review exactly like a fully-grounded one.
    m112_evidence_label: criticResult.evidenceLabel,
    m112_evidence_unverified: criticResult.unverifiedCount,
    // Same reasoning one field up, for the other thing a user cannot see by
    // looking at a review: how much of the diff it was actually shown. The
    // prompt asks the reviewer to admit partial coverage and nothing verifies
    // that it did, so this count — siltpoke's own, not the model's — is what
    // stops a review written on a quarter of a diff from reading like a
    // review written on all of it. Absent when the whole diff fitted.
    m112_diff_shown: criticResult.diffCoverage?.shown,
    m112_diff_total: criticResult.diffCoverage?.total,
    critique_id: critiqueId,
    branch,
    brain_output: out,
    usage: criticResult.usage,
    bubble_suppressed: normalBubbleSuppressed ? true : undefined,
    state_written: normalBubbleSuppressed ? false : stateError === undefined,
    state_error: stateError,
    xp_awarded: xpAwarded,
    leveled_up: leveledUp,
    diff_snapshot_id: criticResult.diffSnapshotId,
    diff_summary: "diffSummary" in criticResult ? criticResult.diffSummary : undefined,
    timing: criticResult.timing,
    summary_error: criticResult.summaryError,
    ...pf,
    ...memoryFunnelFields(criticResult),
    ...promptBytesFields(criticResult),
    ...capturedIntentFields(criticResult),
  });
  // Fire-and-forget side effects on the fired write (see PASSIVE_BUBBLE
  // above for the same discipline): re-render the menu bar instantly,
  // and (mute/platform-gated) pop a desktop notification.
  refreshMenubar(opts?.menubarDeps);
  if (!normalBubbleSuppressed) {
    notifyReview(normalEffectiveBubble, isMuted(homeBase, now), opts?.menubarDeps);
  }
}

interface ToolAugmentedPathInput {
  event: HookEvent;
  env: NodeJS.ProcessEnv;
  opts: HandleStopHookOptions | undefined;
  homeBase: string;
  stateBase: string;
  now: Date;
  t0: number;
  contextHash: string;
  bundleText: string;
  personalitySystemPrompt: string;
  memory: CoreMemory | null;
  recent: RecentEntry[];
  costConfig: CostConfig;
  consolidateFn: typeof consolidate;
  /**
   * Anti-examples block computed once by `buildPromptContext` (Task B
   * critical #1) — threaded into `BrainContext` below so both
   * `runNormalPhase` and `runPassiveBubblePhase` (the tool-augmented path's
   * OWN prompt-assembly calls) receive it, since this is the DEFAULT path
   * and `buildPromptContext`'s own `systemPrompt` return is only ever
   * consumed by the legacy (`SILTPOKE_TOOL_AUGMENTED=0`) fallback.
   */
  antiExamplesBlock: string;
  /** Forward-capture case1-freeze gate (Task 8) — read from disk once per hook. */
  case1CaptureConfig: Case1CaptureConfig;
  /**
   * The unit of work the review-unit gate named (`<lastReviewedHead>..HEAD`,
   * spec D2), forwarded to `runCritic` so git-diff shows the unit instead of
   * the working tree. Absent on a forced review, which named no unit.
   */
  revisionRange?: string;
}

async function runToolAugmentedPath(input: ToolAugmentedPathInput): Promise<void> {
  const {
    event,
    env,
    opts,
    homeBase,
    stateBase,
    now,
    t0,
    contextHash,
    bundleText,
    personalitySystemPrompt,
    memory,
    recent,
    costConfig,
    consolidateFn,
    antiExamplesBlock,
    case1CaptureConfig,
    revisionRange,
  } = input;

  try {
    console.error("[siltpoke] tool-augmented critic path active");

    // Menu-bar-pet T1 — captured once per fired attempt, not per pre-spawn
    // skip gate above (git rev-parse is cheap but pointless to shell out
    // on a turn that never reaches a Brain call).
    const branch = captureBranch(event.cwd ?? process.cwd(), opts?.gitBranch);

    const caps = await getProjectCapabilities(event.cwd ?? process.cwd());

    const sessionCwd = event.cwd ?? process.cwd();
    const sessionId = event.session_id!;
    // Capture-if-missing, not a bare read: SessionStart may have baselined a
    // different directory (host launched from a multi-repo parent), which left
    // every critique of that session with `created_sha: null` and the oracle
    // abstaining `no_baseline_sha` forever. See session-baseline.ts.
    const sessionHeadSha = resolveOrCaptureSessionHeadSha(sessionCwd, sessionId);

    // Slice ④ task 3 — record commit→session forward index (WHY ← transcript)
    // at Stop. Guarded on event.cwd being present: session_id/transcript_path
    // are already guaranteed non-null here by shouldFire's gate at the top of
    // handleStopHook (checkFireGate), but event.cwd is optional (see
    // warnIfEventCwdAbsent) and writing why-index.json under the wrong
    // directory (e.g. a daemon's frozen process.cwd() fallback) would be
    // worse than skipping. maybeRecordWhy itself no-ops on a missing/stale
    // baseline or a no-commits session, and never throws into this path.
    //
    // ORDERING NOTE (declared because it is invisible at both sites): the
    // `resolveOrCaptureSessionHeadSha` call above may WRITE a baseline record
    // that this call then reads, so the early-out below is no longer reached in
    // the parent-launch shape. `maybeRecordWhy` refuses a `late_capture` record
    // explicitly for that reason — do not drop that check on the grounds that
    // "a baseline is always present now".
    if (event.cwd) {
      await maybeRecordWhy({
        cwd: event.cwd,
        sessionId,
        transcriptPath: event.transcript_path!,
        host: resolveWhyHost(event.siltpoke_host),
        stopTime: new Date().toISOString(),
      });
    }

    // Build-2 sweep: launch the detached distil worker to adjudicate PRIOR
    // pending critiques against current git state, BEFORE this turn's
    // critique is enqueued. Zero LLM / zero queue mutation in-hook — this
    // only spawns the worker (or no-ops). Guarded — a launch failure must
    // never break the live Stop-hook review.
    await maybeLaunchDistilWorker(homeBase, stateBase, sessionCwd).catch(() => {});

    const gitBaseline = await captureGitBaseline(sessionCwd);
    const m112ChangedFiles = await extractChangedFiles(event.transcript_path!, {
      cwd: event.cwd ?? process.cwd(),
      gitBaseline,
      pruneMissing: true,
      confineToCwd: true,
    });

    const transcriptTurns = await extractTranscriptTurns(
      event.transcript_path!,
    );

    const { tracer, traceStore } = await buildTracerBundle(homeBase);

    const criticResult = await runCritic(
      {
        source: "stop-hook",
        cwd: event.cwd ?? process.cwd(),
        changedFiles: m112ChangedFiles,
        caps,
        gitBaseline,
        transcriptTurns,
        tracer,
        traceStore,
        revisionRange,
        brainContext: {
          personalitySystemPrompt,
          memory,
          recent,
          fileTypes: detectFileTypes(bundleText),
          maxRules: costConfig.maxRules,
          recentInjectionCount: costConfig.recentInjectionCount,
          sessionId: event.session_id!,
          cwd: event.cwd ?? "",
          stateBase,
          antiExamplesBlock,
        },
        homeBase,
      },
      opts?.m112Deps,
    );

    await commitHash(homeBase, event.session_id!, contextHash);

    // Handle result by decision
    if (criticResult.decision === "HARD_SUPPRESS") {
      await handleHardSuppress(criticResult, env, event, t0);
      return;
    }

    if (criticResult.decision === "PASSIVE_BUBBLE") {
      await handlePassiveBubble(criticResult, {
        env,
        event,
        t0,
        homeBase,
        stateBase,
        now,
        opts,
        branch,
      });
      return;
    }

    // NORMAL path
    const out = criticResult.critique;
    const pf = providerFields(criticResult, authorFamilyFor(homeBase));
    // F4: record Brain tokens for the NORMAL run. (Used to say "for both
    // accepted and rejected guard outcomes" — there is no rejected outcome
    // left: the evidence check labels citations instead of dropping reviews.)
    await appendUsageEvent(homeBase, {
      ts: new Date().toISOString(),
      kind: "main",
      session_id: event.session_id!,
      input_tokens: criticResult.usage.input_tokens,
      output_tokens: criticResult.usage.output_tokens,
      cache_creation_input_tokens: criticResult.usage.cache_creation_input_tokens,
      cache_read_input_tokens: criticResult.usage.cache_read_input_tokens,
      total_cost_usd: criticResult.usage.total_cost_usd,
      ...pf,
    });
    await handleNormalAccepted(criticResult, out, pf, {
      env,
      event,
      t0,
      homeBase,
      stateBase,
      now,
      opts,
      branch,
      sessionHeadSha,
      case1CaptureConfig,
    });
  } catch (err) {
    // cwd included so the /timeline errors facet can attribute the
    // failure to a project instead of "(unknown)".
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      duration_ms: Date.now() - t0,
      m112_path: true,
      error_message: String(err),
    });
  }

  await triggerConsolidation(consolidateFn, homeBase, stateBase, event.cwd);
}

interface LegacyPathInput {
  event: HookEvent;
  env: NodeJS.ProcessEnv;
  opts: HandleStopHookOptions | undefined;
  homeBase: string;
  stateBase: string;
  t0: number;
  contextHash: string;
  systemPrompt: string;
  bundle: ContextBundle;
  memoryRulesCount: number;
  memoryFunnel: MemoryFunnel;
  recentEntriesCount: number;
  consolidateFn: typeof consolidate;
  /** Forward-capture case1-freeze gate (Task 8) — read from disk once per hook. */
  case1CaptureConfig: Case1CaptureConfig;
}

async function runLegacyPath(input: LegacyPathInput): Promise<void> {
  const {
    event,
    env,
    opts,
    homeBase,
    stateBase,
    t0,
    contextHash,
    systemPrompt,
    bundle,
    memoryRulesCount,
    memoryFunnel,
    recentEntriesCount,
    consolidateFn,
    case1CaptureConfig,
  } = input;

  try {
    // Build-2 sweep: launch the detached distil worker to adjudicate PRIOR
    // pending critiques against current git state, BEFORE this turn's
    // critique is enqueued below. Guarded — a launch failure must never
    // break the live Stop-hook review. Mirrors runToolAugmentedPath's
    // placement; this is the SILTPOKE_TOOL_AUGMENTED=0 legacy fallback
    // path, which previously never launched a sweep at all — in a
    // pure-legacy session, pending entries only drained via the
    // SessionStart flush.
    await maybeLaunchDistilWorker(homeBase, stateBase, event.cwd ?? process.cwd()).catch(() => {});

    // Default Brain call goes through the guarded wrapper
    // (classify → record → throttle 1-retry). Tests injecting brainFn
    // bypass the guard deliberately.
    const brain = opts?.brainFn ?? makeGuardedCallBrain({ homeBase });
    const { output: out, usage } = await brain({
      systemPrompt,
      contextBundle: bundle.text,
    });

    await commitHash(homeBase, event.session_id!, contextHash);

    const usageEvent: UsageEvent = {
      ts: new Date().toISOString(),
      kind: "main",
      session_id: event.session_id!,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      total_cost_usd: usage.total_cost_usd,
    };
    await appendUsageEvent(homeBase, usageEvent);

    let stateError: string | undefined;
    let critiqueId: string | undefined;
    let critiqueError: string | undefined;

    const gating = out.confidence;
    // Critique inbox is reserved for actionable findings. info-level
    // outputs (status complete / no code to review / chit-chat) update
    // the bubble + mood but do NOT write a critique file — they used to
    // pollute /siltpoke-inbox with non-reviews.
    const writeCritiqueFile = gating === "high" && out.severity !== "info";
    const showBubble = gating !== "low";

    // Empty effective bubble (low gating OR Brain emitted an
    // empty bubble) → skip the state write; keep the jsonl telemetry line.
    const legacyEffectiveBubble = showBubble ? out.bubble_short : "";
    const legacyBubbleSuppressed = legacyEffectiveBubble.trim().length === 0;
    if (!legacyBubbleSuppressed) {
      try {
        await writeState(stateBase, {
          schemaVersion: 1,
          mood: out.mood,
          pose: out.pose,
          bubble_short: legacyEffectiveBubble,
          severity: out.severity,
          confidence: out.confidence,
          last_updated_ms: Date.now(),
          last_session_id: event.session_id!,
        });
      } catch (err) {
        stateError = String(err);
      }
    }

    if (writeCritiqueFile) {
      try {
        // Critiques are scoped to the project — landing them in homeBase
        // mixes review context across unrelated codebases. stateBase is
        // already per-project, so reuse it.
        const written = await writeCritique(stateBase, {
          brain_output: out,
          session_id: event.session_id!,
          cwd: event.cwd ?? "",
        });
        critiqueId = written.id;
      } catch (err) {
        critiqueError = String(err);
      }

      // Build-2 enqueue: park a pending critique for deferred acted-on
      // adjudication by a later sweep. Guarded end-to-end — enqueue must
      // never break the live Stop-hook review. (This is the legacy
      // SILTPOKE_TOOL_AUGMENTED=0 fallback path — sessionCwd/sessionId/
      // sessionHeadSha aren't in scope here, so resolve them locally,
      // mirroring runToolAugmentedPath's live-path wiring.)
      try {
        if (critiqueId && out.evidence.length > 0) {
          const legacySessionCwd = event.cwd ?? process.cwd();
          const legacySessionId = event.session_id!;
          const legacySessionHeadSha = resolveOrCaptureSessionHeadSha(legacySessionCwd, legacySessionId);
          const contentCache = new Map<string, string>();
          const readOnce = async (f: string): Promise<string> => {
            if (contentCache.has(f)) return contentCache.get(f)!;
            let text = "";
            try {
              text = await readFile(join(legacySessionCwd, f), "utf8");
            } catch {
              text = "";
            }
            contentCache.set(f, text);
            return text;
          };
          const anchors = [];
          for (const e of out.evidence) {
            const content = await readOnce(e.file);
            anchors.push({
              file: e.file,
              line: e.line,
              tool: e.tool,
              fingerprint: content ? lineContentFingerprint(content, e.line ?? 0) : "",
            });
          }
          const baseEntry = pendingCritiqueSchema.parse({
            critique_id: critiqueId,
            session_id: legacySessionId,
            created_sha: legacySessionHeadSha ?? null,
            created_at: new Date().toISOString(),
            hooks_elapsed: 0,
            status: "pending",
            severity: out.severity,
            finding_text: out.critique_for_claude,
            anchors,
          });
          // Forward-capture Phase 1 (Task 8) — opt-in, default OFF; a failure
          // here must never block or alter the enqueue below.
          const entry = await stampCase1Capture(
            baseEntry,
            {
              critique_id: critiqueId,
              session_id: legacySessionId,
              cwd: legacySessionCwd,
              stateBase,
              finding_text: out.critique_for_claude,
              severity: out.severity,
              anchors,
              evidenceFiles: out.evidence.map((e) => e.file),
              config: case1CaptureConfig,
              env,
            },
            nodeCaptureDeps,
          );
          await enqueuePending(pendingQueuePath(stateBase), entry);
        }
      } catch {
        // Build-2 enqueue must never break the review.
      }
    }

    const { xpAwarded, leveledUp } = await awardXpFromEvents(homeBase, out.xp_earned_events);

    // No `capturedIntentFields` here, and that is not an oversight: this is the
    // LEGACY (non-m112) writer, reached only when `criticPipeline.enabled` is
    // false — in which case `runPreBrainPipeline` returns `{pipelineRan: false}`
    // with no `capturedIntent` at all, so there is nothing to spread. Written
    // down because the coupling is invisible from here, and a reader comparing
    // the five row writers would otherwise read this as a missed site.
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      turns_included: bundle.turns_included,
      duration_ms: Date.now() - t0,
      brain_output: out,
      usage,
      memory_rules_count: memoryRulesCount,
      ...memoryFunnel,
      recent_entries_count: recentEntriesCount,
      bubble_suppressed: legacyBubbleSuppressed ? true : undefined,
      state_written: legacyBubbleSuppressed ? false : stateError === undefined,
      critique_id: critiqueId,
      state_error: stateError,
      critique_error: critiqueError,
      context_hash: contextHash,
      gating_decision: gating,
      xp_awarded: xpAwarded,
      leveled_up: leveledUp,
    });
  } catch (err) {
    // cwd included so the /timeline errors facet can attribute the
    // failure to a project instead of "(unknown)".
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      duration_ms: Date.now() - t0,
      error_message: err instanceof BrainError ? err.message : String(err),
    });
  }

  await triggerConsolidation(consolidateFn, homeBase, stateBase, event.cwd);
}
