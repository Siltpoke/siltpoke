// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { join } from "node:path";
import { loadDailyRollup } from "../state/usage";
import {
  loadBudgetConfig,
  evaluateBudget,
  type BudgetStage,
} from "../state/budget-config";
import {
  loadQuietHoursConfig,
  isQuietHour,
} from "../state/quiet-hours";
import {
  loadTriggerConfig,
  type TriggerMode,
} from "../router/trigger-modes";
import { getTodayTelemetry, type CriticCounters } from "../state/critic-counters";
import { readMemory } from "../memory/memory";
import { chatSessionStats } from "../chat/sessions";

export interface StatsOptions {
  homeBase?: string;
  now?: () => Date;
}

export interface StatsResult {
  day: string;
  used_pct: number;
  remaining_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_tokens: number;
  total_cost_usd: number;
  brain_calls: number;
  reflections: number;
  trigger_mode: TriggerMode;
  quiet_active: boolean;
  budget_stage: BudgetStage;
  daily_token_limit: number;
  /** Critic telemetry for today. Absent when no runs recorded yet. */
  criticCounters?: CriticCounters;
  /** Count of facts with status==="pending" in memory. 0 when memory unreadable. */
  pending_facts: number;
  /** Chat sessions accumulated across all time. 0 when memory unreadable. */
  chat_sessions_total: number;
  /** Total messages across all sessions. */
  chat_messages_total: number;
  /** ISO timestamp of the most recently ended session, or null. */
  chat_last_activity: string | null;
}

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

export async function runStats(opts: StatsOptions = {}): Promise<StatsResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const now = (opts.now ?? (() => new Date()))();

  const budgetConfig = await loadBudgetConfig(homeBase);
  const quietConfig = await loadQuietHoursConfig(homeBase);
  const triggerConfig = await loadTriggerConfig(homeBase);

  const rollup = await loadDailyRollup(homeBase, now, budgetConfig.resetAtMinutes);
  const budget = evaluateBudget(rollup, budgetConfig);

  const telemetry = await getTodayTelemetry(homeBase);
  // Only include telemetry if there has been at least one run today.
  const criticCounters = telemetry.totalCritiqueRuns > 0 ? telemetry : undefined;

  // PQ7: count pending facts; swallow errors so stats never crashes.
  let pending_facts = 0;
  try {
    const memory = await readMemory(homeBase);
    if (memory !== null) {
      pending_facts = memory.facts.filter((f) => f.status === "pending").length;
    }
  } catch {
    // memory unreadable — leave pending_facts at 0
  }

  // Chat session stats; swallow errors.
  let chat_sessions_total = 0;
  let chat_messages_total = 0;
  let chat_last_activity: string | null = null;
  try {
    const stats = await chatSessionStats(homeBase);
    chat_sessions_total = stats.total_sessions;
    chat_messages_total = stats.total_messages;
    chat_last_activity = stats.most_recent_ended_at;
  } catch {
    // memory unreadable
  }

  return {
    day: rollup.day,
    used_pct: budget.used_pct,
    remaining_tokens: budget.remaining_tokens,
    total_input_tokens: rollup.total_input_tokens,
    total_output_tokens: rollup.total_output_tokens,
    total_cache_tokens: rollup.total_cache_tokens,
    total_cost_usd: rollup.total_cost_usd,
    brain_calls: rollup.brain_calls,
    reflections: rollup.reflections,
    trigger_mode: triggerConfig.mode,
    quiet_active: isQuietHour(now, quietConfig),
    budget_stage: budget.stage,
    daily_token_limit: budgetConfig.dailyTokenLimit,
    criticCounters,
    pending_facts,
    chat_sessions_total,
    chat_messages_total,
    chat_last_activity,
  };
}

/**
 * Render the memory section for human-readable terminal output.
 * Includes pending_facts count. Never throws.
 */
export function formatMemorySection(pending_facts: number): string {
  return ["=== Memory ===", `pending_facts: ${pending_facts}`].join("\n");
}

/**
 * Render the chat section for human-readable terminal output.
 * Returns an empty string when no chat activity has ever been recorded
 * (avoids a noisy section for fresh installs).
 */
export function formatChatSection(
  sessions: number,
  messages: number,
  lastActivity: string | null,
): string {
  if (sessions === 0 && messages === 0) return "";
  return [
    "=== Chat ===",
    `sessions: ${sessions}`,
    `messages: ${messages}`,
    `last_activity: ${lastActivity ?? "n/a"}`,
  ].join("\n");
}

/**
 * Render the critic telemetry section for human-readable terminal output.
 * Returns an empty string when no runs have been recorded today.
 */
export function formatCriticTelemetrySection(tel: CriticCounters | undefined): string {
  if (tel === undefined || tel.totalCritiqueRuns === 0) return "";

  const lines: string[] = [];
  lines.push("=== Code Review ===");
  lines.push(`total runs today: ${tel.totalCritiqueRuns}`);

  const abstentionRate =
    tel.totalCritiqueRuns > 0
      ? (tel.abstentionCount / tel.totalCritiqueRuns) * 100
      : 0;
  const abstentionPct = abstentionRate.toFixed(1);
  lines.push(`abstention rate: ${abstentionPct}% (${tel.abstentionCount} / ${tel.totalCritiqueRuns})`);

  const guardRejectCount = tel.normalRejectedCount;
  const normalAcceptedCount = tel.normalAttemptCount - guardRejectCount;
  lines.push(
    `gate decisions: ${normalAcceptedCount} NORMAL accepted, ${tel.passiveBubbleCount} PASSIVE_BUBBLE, ${tel.hardSuppressCount} HARD_SUPPRESS, ${guardRejectCount} guard-reject`,
  );

  // Tool status table
  lines.push("tool status:");
  for (const tool of ["tsc", "eslint", "git-diff", "ripgrep"] as const) {
    const counts = tel.toolStatusCounts[tool];
    const ok = counts.ok;
    const notInstalled = counts.not_installed;
    const timeout = counts.timeout;
    const error = counts.error;
    const notApplicable = counts.not_applicable;
    lines.push(
      `  ${tool.padEnd(10)} ${ok} ok, ${notInstalled} not_installed, ${timeout} timeout, ${error} error, ${notApplicable} not_applicable`,
    );
  }

  // Top guard reject reasons (sorted by count desc, max 5)
  const rejectEntries = Object.entries(tel.guardRejectReasons).sort(
    ([, a], [, b]) => b - a,
  );
  if (rejectEntries.length > 0) {
    lines.push("top guard rejects:");
    for (const [reason, count] of rejectEntries.slice(0, 5)) {
      lines.push(`  - "${reason}" (${count})`);
    }
  }

  // PQ8: abstention rate warning threshold
  if (abstentionRate > 20) {
    lines.push(
      "⚠️  abstention rate above 20% — PQ2/PQ3 may be mis-tuned (or you're using non-TS repos).",
    );
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const result = await runStats();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  process.stdout.write(`\n${formatMemorySection(result.pending_facts)}\n`);

  const chatSection = formatChatSection(
    result.chat_sessions_total,
    result.chat_messages_total,
    result.chat_last_activity,
  );
  if (chatSection) {
    process.stdout.write(`\n${chatSection}\n`);
  }

  const criticSection = formatCriticTelemetrySection(result.criticCounters);
  if (criticSection) {
    process.stderr.write(`\n${criticSection}\n`);
  }

  process.exit(0);
}
