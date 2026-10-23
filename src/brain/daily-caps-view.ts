// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Each role's daily cap and how many calls it has made today (spec §12.1,
 * §12.3) — what the Settings page shows under every cap field. Read from the
 * same config keys and the same `brain-health.json` counter the guarded call
 * checks, with the same day boundary, so the page and the brake cannot
 * disagree.
 */
import {
  loadChatQuotaDailyCapSync,
  loadExtractQuotaDailyCapSync,
  loadQuotaDailyCapSync,
} from "../config/brain-quota-cap-config";
import { quotaUsedToday, readBrainHealth } from "../state/brain-health";
import { loadBudgetConfigSync } from "../state/budget-config";
import type { QuotaUse } from "./brain-guarded";

export type PerRole = Record<QuotaUse, number>;

export function dailyCapsView(home: string, now: Date = new Date()): { caps: PerRole; usage: PerRole } {
  const health = readBrainHealth(home);
  const { resetAtMinutes } = loadBudgetConfigSync(home);
  const used = (role: QuotaUse): number => quotaUsedToday(health, role, now, resetAtMinutes);
  return {
    caps: {
      chat: loadChatQuotaDailyCapSync(home),
      review: loadQuotaDailyCapSync(home),
      extract: loadExtractQuotaDailyCapSync(home),
    },
    usage: { chat: used("chat"), review: used("review"), extract: used("extract") },
  };
}
