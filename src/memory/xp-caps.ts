// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Daily XP cap table.
 *
 * Per-source cap of how many XP-earning events count toward `xp_total`
 * before the source is rate-limited for the rest of the local day.
 * Excess events are still recorded in `xp_log[]` with `amount: 0` and
 * `capped: true` so the user can see "you tried to farm; we noticed".
 *
 * Caps are intentionally generous. The intent is to block obvious farming
 * (open 100 repos in a day, dismiss-and-redismiss the same critique to
 * grind XP), not to nickel-and-dime real engagement.
 */
import type { XpSource } from "./schema-v3";

export const DAILY_CAPS: Record<XpSource, number> = {
  forwarded_critique: 20,
  accepted_fact: 30,
  fact_inferred: 30,
  first_chat_of_day: 1,
  streak_milestone: 1,
  achievement_unlock: 5,
  manual_pet: 5,
};

export function dailyCapFor(source: XpSource): number {
  return DAILY_CAPS[source];
}
