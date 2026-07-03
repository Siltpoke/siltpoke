// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure send-gate evaluation logic, extracted from the inline
 * closure in server.ts so it can be unit-tested independently of disk I/O.
 *
 * evaluateChatSendGate is the REAL composition of evaluateBudget + isQuietHour
 * with the same ordering the server.ts closure uses:
 *   1. Quiet-hours checked FIRST (cheaper — no disk rollup scan).
 *   2. Budget hard-stop only (soft stage is intentionally pass-through).
 *
 * The server.ts closure delegates to this pure function after loading its
 * deps from disk; tests call it directly with synthetic inputs.
 */
import type { BudgetConfig } from "../../state/budget-config";
import { evaluateBudget } from "../../state/budget-config";
import type { QuietHoursConfig } from "../../state/quiet-hours";
import { isQuietHour } from "../../state/quiet-hours";
import type { DailyRollup } from "../../state/usage";
import type { BudgetSignal, QuietHoursSignal } from "./chat";

/**
 * Evaluate the send gate synchronously given already-loaded config + rollup.
 *
 * Returns:
 *  - `{ blocked: "quiet_hours" }` — quiet hours active.
 *  - `{ blocked: "budget", used_pct }` — daily budget hard-stop reached.
 *  - `null` — neither; the send may proceed.
 *
 * Soft budget (stage === "soft") is deliberately pass-through: chat sends are
 * not blocked by soft budget (only the Stop hook's trigger mode changes).
 */
export function evaluateChatSendGate(
  config: BudgetConfig,
  rollup: DailyRollup,
  quietConfig: QuietHoursConfig,
  now: Date,
): BudgetSignal | QuietHoursSignal | null {
  // Quiet-hours first (cheaper).
  if (isQuietHour(now, quietConfig)) {
    return { blocked: "quiet_hours" };
  }
  // Budget hard-stop only; soft is pass-through.
  const decision = evaluateBudget(rollup, config);
  if (decision.stage === "hard") {
    return { blocked: "budget", used_pct: decision.used_pct };
  }
  return null;
}
