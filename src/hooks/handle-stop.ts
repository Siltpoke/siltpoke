// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldFire, type HookEvent } from "../router/router";
import {
  packContext,
  extractChangedFiles,
  extractLatestUserMessage,
} from "../router/context";
import { loadPersonality, buildSystemPrompt } from "../brain/personality";
import {
  BrainError,
  type CallBrainOptions,
  type BrainCallResult,
} from "../brain/brain";
import { makeGuardedCallBrain } from "../brain/brain-guarded";
import {
  readBrainHealth,
  writeBrainHealth,
  isBreakerOpen,
  clearBreaker,
} from "../state/brain-health";
import { writeState } from "../state/state";
import { writeCritique } from "../state/critique";
import { readMemory } from "../memory/memory";
import { readRecent, resolveRecentPath } from "../memory/recent";
import { assembleSystemPrompt } from "../brain/prompt-assembly";
import { detectFileTypes } from "../brain/rule-selector";
import { loadCostConfig } from "../brain/cost-config";
import {
  evaluateSkip,
  commitHash,
  buildSignature,
} from "../router/skip-detector";
import { loadBudgetConfig, evaluateBudget } from "../state/budget-config";
import { loadQuietHoursConfig, isQuietHour } from "../state/quiet-hours";
import {
  loadTriggerConfig,
  evaluateTriggerMode,
} from "../router/trigger-modes";
import {
  appendUsageEvent,
  loadDailyRollup,
  type UsageEvent,
} from "../state/usage";
import { consumeWake } from "../cli/wake";
import { isMuted } from "../state/mute";
import {
  addXp,
  readProgression,
  writeProgression,
} from "../state/progression";
import { getProjectCapabilities } from "../critic/capabilities";
import { captureGitBaseline } from "../router/git-snapshot";
import { runCritic, type RunCriticDeps } from "../critic/run-critic";
import { Tracer } from "../observability/tracer";
import { TraceStore } from "../observability/storage";
import { consolidate } from "../memory/consolidate";
import { extractTranscriptTurns } from "../router/extract-turns";

export function siltpokeHome(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? "", ".siltpoke");
}

export function logPath(env: NodeJS.ProcessEnv): string {
  return join(siltpokeHome(env), "brain-calls.jsonl");
}

export async function appendJsonLine(
  env: NodeJS.ProcessEnv,
  obj: unknown,
): Promise<void> {
  try {
    await mkdir(siltpokeHome(env), { recursive: true });
    await appendFile(logPath(env), `${JSON.stringify(obj)}\n`);
  } catch {
    // Logger failures must never crash the hook.
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
}

export async function handleStopHook(
  event: HookEvent,
  opts?: HandleStopHookOptions,
): Promise<void> {
  const env = opts?.env ?? process.env;
  const consolidateFn = opts?.consolidateFn ?? consolidate;

  const decision = shouldFire(event, env);
  if (!decision.fire) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: decision.reason,
    });
    return;
  }

  const homeBase = siltpokeHome(env);
  const now = new Date();

  // Mute beats wake. If the user ran /siltpoke-mute, short-circuit
  // BEFORE consuming the wake marker so an unused wake survives the mute
  // window. Mute is fail-open (missing/corrupt file = not muted).
  if (isMuted(homeBase, now)) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: "muted",
    });
    return;
  }

  // Consume any pending /siltpoke-wake bypass; the file is deleted whether
  // or not the timestamp is still fresh (one-shot).
  const wakeBypass = await consumeWake(homeBase, now);

  // Trigger mode gate. always/gates/on_demand/hybrid.
  const triggerConfig = await loadTriggerConfig(homeBase);
  const triggerDecision = evaluateTriggerMode(event, triggerConfig, wakeBypass);
  if (!triggerDecision.fire) {
    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      skipped: triggerDecision.reason,
      trigger_mode: triggerConfig.mode,
    });
    return;
  }

  // Brain circuit breaker — while open, skip the spawn
  // entirely and write a telemetry skip record. /siltpoke-wake clears the
  // breaker (the user's explicit "try now"); this is also the self-serve
  // clear for a latched permanent class.
  {
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
        return;
      }
    }
  }

  const stateBase =
    event.cwd && event.cwd.length > 0
      ? join(event.cwd, ".siltpoke")
      : homeBase;

  async function writeSleepingState(mood: "sleeping_quiet" | "sleeping_broke"): Promise<void> {
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

  // Quiet hours. Bypass skips this gate.
  if (!wakeBypass) {
    const quietConfig = await loadQuietHoursConfig(homeBase);
    if (isQuietHour(now, quietConfig)) {
      await writeSleepingState("sleeping_quiet");
      await appendJsonLine(env, {
        timestamp: now.toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        skipped: "quiet_hours",
        mood: "sleeping_quiet",
      });
      return;
    }
  }

  // Budget gate. Bypass skips this gate.
  const budgetConfig = await loadBudgetConfig(homeBase);
  if (!wakeBypass) {
    const rollup = await loadDailyRollup(homeBase, now, budgetConfig.resetAtMinutes);
    const budget = evaluateBudget(rollup, budgetConfig);
    if (budget.stage === "hard") {
      await writeSleepingState("sleeping_broke");
      await appendJsonLine(env, {
        timestamp: now.toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        skipped: "budget_hard_stop",
        used_pct: budget.used_pct,
        mood: "sleeping_broke",
      });
      return;
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
      return;
    }
  }

  const costConfig = await loadCostConfig(homeBase);

  const bundle = await packContext({
    session_id: event.session_id!,
    cwd: event.cwd ?? process.cwd(),
    transcript_path: event.transcript_path!,
    maxTurns: costConfig.maxTranscriptTurns,
  });

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
  const fileTypes = detectFileTypes(bundle.text);
  const systemPrompt = assembleSystemPrompt({
    personalitySystemPrompt,
    memory,
    recent,
    fileTypes,
    maxRules: costConfig.maxRules,
    recentInjectionCount: costConfig.recentInjectionCount,
  });
  const memoryRulesCount = memory
    ? memory.learned_rules.filter((r) => r.effectiveness !== "retired").length
    : 0;
  const recentEntriesCount = recent.length;

  // pruneMissing: drop transcript paths renamed/deleted later in the session so
  // the critic doesn't flag files that no longer exist (e.g. a kebab-case rename).
  const changedFiles = await extractChangedFiles(event.transcript_path!, {
    cwd: event.cwd,
    pruneMissing: true,
  });
  const latestUserMessage = await extractLatestUserMessage(
    event.transcript_path!,
  );

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
    return;
  }

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
    return;
  }

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
    try {
      console.error("[siltpoke] tool-augmented critic path active");

      const caps = await getProjectCapabilities(event.cwd ?? process.cwd());

      // Disk-first baseline — read HEAD SHA captured at session start.
      // The persisted baseline.json is written by the SessionStart hook and
      // contains the HEAD SHA before any commits during this session. We read
      // it here as a fallback hint; the git-status GitBaseline (entries map)
      // still comes from captureGitBaseline() for change-file detection.
      // When the SessionStart hook was not installed (no baseline.json) or the
      // session_id doesn't match, we fall through to captureGitBaseline() as before.
      const sessionCwd = event.cwd ?? process.cwd();
      const sessionId = event.session_id!;
      const baselineFile = join(sessionCwd, ".siltpoke", "baseline.json");
      let sessionHeadSha: string | null = null;
      if (existsSync(baselineFile)) {
        try {
          const persisted = JSON.parse(readFileSync(baselineFile, "utf8"));
          if (
            typeof persisted.head_sha === "string" &&
            persisted.session_id === sessionId
          ) {
            sessionHeadSha = persisted.head_sha;
          }
        } catch {
          // fall through — non-fatal
        }
      }

      const gitBaseline = await captureGitBaseline(sessionCwd);
      // sessionHeadSha is available for telemetry / future use (e.g. git diff <sha>..HEAD)
      void sessionHeadSha;
      const m112ChangedFiles = await extractChangedFiles(event.transcript_path!, {
        cwd: event.cwd ?? process.cwd(),
        gitBaseline,
        pruneMissing: true,
      });

      const transcriptTurns = await extractTranscriptTurns(
        event.transcript_path!,
      );

      // OTEL tracer + store: construct lazily so each Stop hook produces its
      // own root span tree. Fail-soft — if construction throws (missing
      // directory, sqlite open error), proceed without tracing rather than
      // blocking the critic.
      let tracer: Tracer | undefined;
      let traceStore: TraceStore | undefined;
      try {
        const tracesDir = join(homeBase, "traces");
        const spilloverDir = join(tracesDir, "spillover");
        await mkdir(tracesDir, { recursive: true });
        await mkdir(spilloverDir, { recursive: true });
        tracer = new Tracer({ spilloverDir });
        traceStore = new TraceStore({
          dir: tracesDir,
          dbPath: join(tracesDir, "index.sqlite"),
        });
      } catch {
        tracer = undefined;
        traceStore = undefined;
      }

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
          brainContext: {
            personalitySystemPrompt,
            memory,
            recent,
            fileTypes: detectFileTypes(bundle.text),
            maxRules: costConfig.maxRules,
            recentInjectionCount: costConfig.recentInjectionCount,
            sessionId: event.session_id!,
            cwd: event.cwd ?? "",
            stateBase,
          },
          homeBase,
        },
        opts?.m112Deps,
      );

      await commitHash(homeBase, event.session_id!, skipDecision.hash);

      // Handle result by decision
      if (criticResult.decision === "HARD_SUPPRESS") {
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
        });
        return;
      }

      if (criticResult.decision === "PASSIVE_BUBBLE") {
        const out = criticResult.critique;
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
          bubble_suppressed: passiveBubbleSuppressed ? true : undefined,
          critique_id: "critiqueId" in criticResult ? criticResult.critiqueId : undefined,
          brain_output: out,
          // Rail/header cost+token readout parses `usage` off this line
          // (critic-event-log-parse) — without it every row reads $—/0 tok.
          usage: criticResult.usage,
          diff_snapshot_id: criticResult.diffSnapshotId,
          diff_summary: "diffSummary" in criticResult ? criticResult.diffSummary : undefined,
          timing: criticResult.timing,
          summary_error: criticResult.summaryError,
        });
        return;
      }

      // NORMAL path
      const out = criticResult.critique;
      // F4: record Brain tokens for both accepted and rejected guard outcomes.
      await appendUsageEvent(homeBase, {
        ts: new Date().toISOString(),
        kind: "main",
        session_id: event.session_id!,
        input_tokens: criticResult.usage.input_tokens,
        output_tokens: criticResult.usage.output_tokens,
        cache_creation_input_tokens: criticResult.usage.cache_creation_input_tokens,
        cache_read_input_tokens: criticResult.usage.cache_read_input_tokens,
        total_cost_usd: criticResult.usage.total_cost_usd,
      });
      if (!criticResult.accepted) {
        // Guard rejected — log telemetry, do NOT write critique, do NOT forward
        await appendJsonLine(env, {
          timestamp: new Date().toISOString(),
          session_id: event.session_id,
          cwd: event.cwd,
          duration_ms: Date.now() - t0,
          m112_path: true,
          critic_path_decision: "NORMAL",
          m112_accepted: false,
          m112_guard_reason: criticResult.reason,
          brain_output: out,
          usage: criticResult.usage,
          diff_snapshot_id: criticResult.diffSnapshotId,
          diff_summary: "diffSummary" in criticResult ? criticResult.diffSummary : undefined,
          timing: criticResult.timing,
          summary_error: criticResult.summaryError,
        });
        return;
      }

      // NORMAL accepted — write state, handle XP, log
      let stateError: string | undefined;
      let xpAwarded = 0;
      let leveledUp = false;

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

      if (Array.isArray(out.xp_earned_events) && out.xp_earned_events.length > 0) {
        const totalXp = out.xp_earned_events.reduce(
          (sum, e) => sum + (typeof e.amount === "number" ? e.amount : 0),
          0,
        );
        if (totalXp > 0) {
          const current = await readProgression(homeBase);
          const xpResult = addXp(current, totalXp);
          await writeProgression(homeBase, xpResult.next);
          xpAwarded = xpResult.delta;
          leveledUp = xpResult.leveled_up;
        }
      }

      await appendJsonLine(env, {
        timestamp: new Date().toISOString(),
        session_id: event.session_id,
        cwd: event.cwd,
        duration_ms: Date.now() - t0,
        m112_path: true,
        critic_path_decision: "NORMAL",
        m112_accepted: true,
        critique_id: "critiqueId" in criticResult ? criticResult.critiqueId : undefined,
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

    // Trigger consolidation cadence (hybrid)
    try {
      // projectBase = repo-local .siltpoke (stateBase); the critic writes
      // critiques project-local, so consolidate must read them from there.
      const consolidateResult = await consolidateFn({ homeBase, projectBase: stateBase, projectCwd: event.cwd });
      if (consolidateResult.ran) {
        console.error(
          `[siltpoke memory] consolidated: +${consolidateResult.apply.added} active, ${consolidateResult.apply.skipped} bumped, discarded: ${consolidateResult.apply.discarded}, ${consolidateResult.prune.factsPruned + consolidateResult.prune.pendingPruned} pruned`,
        );
      }
    } catch (err) {
      console.error("[siltpoke memory] consolidate threw:", err);
      // do not propagate; consolidate failure should not crash the Stop hook
    }

    return;
  }

  // ---------------------------------------------------------------------------
  // Legacy baseline path — preserved when SILTPOKE_TOOL_AUGMENTED is OFF.
  // ---------------------------------------------------------------------------
  try {
    // Default Brain call goes through the guarded wrapper
    // (classify → record → throttle 1-retry). Tests injecting brainFn
    // bypass the guard deliberately.
    const brain = opts?.brainFn ?? makeGuardedCallBrain({ homeBase });
    const { output: out, usage } = await brain({
      systemPrompt,
      contextBundle: bundle.text,
    });

    await commitHash(homeBase, event.session_id!, skipDecision.hash);

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
    }

    let xpAwarded = 0;
    let leveledUp = false;
    if (Array.isArray(out.xp_earned_events) && out.xp_earned_events.length > 0) {
      const totalXp = out.xp_earned_events.reduce(
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

    await appendJsonLine(env, {
      timestamp: new Date().toISOString(),
      session_id: event.session_id,
      cwd: event.cwd,
      turns_included: bundle.turns_included,
      duration_ms: Date.now() - t0,
      brain_output: out,
      usage,
      memory_rules_count: memoryRulesCount,
      recent_entries_count: recentEntriesCount,
      bubble_suppressed: legacyBubbleSuppressed ? true : undefined,
      state_written: legacyBubbleSuppressed ? false : stateError === undefined,
      critique_id: critiqueId,
      state_error: stateError,
      critique_error: critiqueError,
      context_hash: skipDecision.hash,
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

  // Trigger consolidation cadence (hybrid)
  try {
    // projectBase = repo-local .siltpoke (stateBase); the critic writes
    // critiques project-local, so consolidate must read them from there.
    const consolidateResult = await consolidateFn({ homeBase, projectBase: stateBase, projectCwd: event.cwd });
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
