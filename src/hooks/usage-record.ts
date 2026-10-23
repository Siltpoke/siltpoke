// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Usage/provider columns for the Stop hook's ledger rows.
 *
 * Split out of handle-stop.ts, which is grandfathered at its length pin: both
 * helpers are pure plumbing with no hook state, and `recordMainUsage` had three
 * verbatim copies of the same nine-field literal inline.
 */

import type { RunCriticResult } from "../critic/types";
import type { BrainUsage } from "../brain/envelope";
import type { ToolCallsField } from "../brain/tool-calls";
import type { InjectionAlert } from "../critic/injection-alert";
import { appendUsageEvent } from "../state/usage";

/**
 * Track #7 T3 (AC7) — provider truth for ledger/telemetry rows. runCritic
 * resolves the reviewer provider once and carries its meta on every
 * RunCriticResult branch (even HARD_SUPPRESS, where no call may have
 * happened); this reads it back with the historical-row-compatible default
 * (absent providerMeta ⇒ claude/usd, matching every pre-track row on disk).
 */
export function providerFields(
  r: RunCriticResult,
  authorFamily: string,
): {
  provider: string;
  billing: "usd" | "quota";
  model: string | undefined;
  authorFamily: string;
  tool_calls?: ToolCallsField;
  injection_alert?: InjectionAlert;
} {
  return {
    provider: r.providerMeta?.name ?? "claude",
    billing: r.providerMeta?.billing ?? "usd",
    model: r.servedModel,
    authorFamily,
    // Which tools the reviewer used (🛡 defence [C]). Absent when no Brain call
    // returned; "not_recorded" when the provider's output carries no tool record.
    tool_calls: r.toolCalls,
    // Prompt-injection alert [B]: present only when a signal fired.
    injection_alert: r.injectionAlert,
  };
}

export type ProviderFields = ReturnType<typeof providerFields>;

/**
 * Record one main-review Brain call against the daily budget rollup (F4).
 * One function because three call sites carried this same nine-field literal,
 * so a field added to one was silently missing from the other two.
 */
export async function recordMainUsage(
  homeBase: string,
  sessionId: string,
  usage: BrainUsage,
  provider?: ProviderFields,
): Promise<void> {
  // The budget rollup counts tokens and money; the tool list belongs on the row only.
  const { tool_calls: _toolCalls, injection_alert: _injectionAlert, ...providerColumns } = provider ?? {};
  await appendUsageEvent(homeBase, {
    ts: new Date().toISOString(),
    kind: "main",
    session_id: sessionId,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    total_cost_usd: usage.total_cost_usd,
    ...providerColumns,
  });
}
