// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { describe, expect, test } from "bun:test";
import { freshBrainHealth, quotaUsedToday } from "../../src/state/brain-health";
import { dayKey } from "../../src/state/usage";

// Spec §12.1: under each cap field, "<n> used today" — read from the same
// counter the cap checks.

const now = new Date("2026-10-15T15:00:00");

function healthWith(key: string, date: string, count: number) {
  return { ...freshBrainHealth(), quota_calls_today: { [key]: { date, count } } };
}

describe("quotaUsedToday", () => {
  test("today's entry → its count", () => {
    expect(quotaUsedToday(healthWith("chat", dayKey(now), 12), "chat", now)).toBe(12);
  });

  test("an entry from another day → 0", () => {
    expect(quotaUsedToday(healthWith("chat", "2026-10-14", 12), "chat", now)).toBe(0);
  });

  test("no entry → 0", () => {
    expect(quotaUsedToday(freshBrainHealth(), "review", now)).toBe(0);
  });

  test("another key's count is not this key's", () => {
    expect(quotaUsedToday(healthWith("review", dayKey(now), 9), "chat", now)).toBe(0);
  });

  test("honours the day-boundary offset the cap uses", () => {
    // 01:00 with a 02:00 reset still belongs to the previous day.
    const early = new Date("2026-10-15T01:00:00");
    const h = healthWith("chat", dayKey(early, 120), 4);
    expect(quotaUsedToday(h, "chat", early, 120)).toBe(4);
    expect(quotaUsedToday(h, "chat", early, 0)).toBe(0);
  });
});
