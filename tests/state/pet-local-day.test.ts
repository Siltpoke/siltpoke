/**
 * The pet's days are the user's local days.
 *
 * `siltpoke pet` / `siltpoke action` already wrote `dayKey(now)` (local); the
 * dashboard and every reader used the UTC date. Between local and UTC midnight
 * — every US evening — a pet landed on a day the XP panel, the streak and the
 * vitals sparkline were not looking at.
 *
 * `bun test` runs in UTC, so these set America/Los_Angeles for the file and
 * put UTC back after (deleting TZ would leak the system zone into later files).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROGRESSION, recordAction, xpPanelData } from "../../src/state/progression";
import { dayBefore, dayKey, startOfDay } from "../../src/state/usage";
import { readVitalsSeries } from "../../src/state/vitalsReader";
import { maybeWriteSnapshot } from "../../src/state/vitalsWriter";

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  process.env.TZ = savedTz ?? "UTC";
});

// 2026-05-18 21:00 in Los Angeles = 2026-05-19 04:00 UTC.
const evening = new Date("2026-05-19T04:00:00Z");

describe("the pet's day is the local day", () => {
  test("the zone really is set (guards the rest of the file)", () => {
    expect(evening.getHours()).toBe(21);
    expect(dayKey(evening)).toBe("2026-05-18");
  });

  test("dayBefore is calendar arithmetic: month ends and the spring DST day", () => {
    expect(dayBefore("2026-05-01")).toBe("2026-04-30");
    expect(dayBefore("2026-03-09")).toBe("2026-03-08");
    expect(dayBefore("2026-03-08")).toBe("2026-03-07");
    expect(startOfDay("2026-03-08").getHours()).toBe(0);
  });

  test("an evening action counts in today's XP panel (UTC put it on tomorrow's empty day)", () => {
    const r = recordAction(structuredClone(DEFAULT_PROGRESSION), dayKey(evening), "pet");
    expect(xpPanelData(r.next, evening).xpToday).toBeGreaterThan(0);
  });

  test("the upgrade evening: a streak stored under tomorrow's UTC date is not reset", () => {
    // Before the change an evening action stored the UTC date (the 19th);
    // tonight's local day is the 18th.
    const before = { ...structuredClone(DEFAULT_PROGRESSION), streak_days_persistent: 5, streak_last_day: "2026-05-19" };
    const after = recordAction(before, dayKey(evening), "pet").next;
    expect(after.streak_days_persistent).toBe(5);
    expect(after.streak_last_day).toBe("2026-05-18");
    // And tomorrow counts as the next day.
    expect(recordAction(after, "2026-05-19", "pet").next.streak_days_persistent).toBe(6);
  });

  test("an action yesterday and one tonight make a two-day streak", () => {
    const first = recordAction(structuredClone(DEFAULT_PROGRESSION), "2026-05-17", "pet").next;
    const second = recordAction(first, dayKey(evening), "pet").next;
    expect(second.streak_days_persistent).toBe(2);
  });

  test("the vitals sparkline's last column is tonight's local day", async () => {
    const home = mkdtempSync(join(tmpdir(), "pet-local-day-"));
    try {
      const prog = recordAction(structuredClone(DEFAULT_PROGRESSION), dayKey(evening), "pet").next;
      await maybeWriteSnapshot(prog, evening, home);
      const series = await readVitalsSeries(home, 7, evening);
      expect(series.xp_awarded.at(-1)).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
