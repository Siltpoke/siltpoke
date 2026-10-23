/**
 * "Today" on the dashboard, the report and the status card is the user's own
 * calendar day, not UTC (chat mainline review leftover C2).
 *
 * `bun test` runs in UTC unless TZ is set, which is why the UTC slicing never
 * showed in a test. These set a US zone for the file and put it back after.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildSparkline } from "../../src/cli/card";
import { bucketByDay } from "../../src/cli/report-panels";
import { lastLocalDays, localDayOf } from "../../src/utils/local-day";

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
// Deleting TZ does not put bun back on UTC (it falls to the system zone and
// leaks into every later file in the run), so restore the value explicitly.
afterAll(() => {
  process.env.TZ = savedTz ?? "UTC";
});

// 2026-05-18 21:00 in Los Angeles = 2026-05-19 04:00 UTC: the evening the old
// code had already moved to "tomorrow".
const evening = new Date("2026-05-19T04:00:00Z");
const earlierThisEvening = "2026-05-19T03:30:00Z"; // 20:30 local, the 18th
const thisMorning = "2026-05-18T16:00:00Z"; // 09:00 local, the 18th
const lastNight = "2026-05-18T06:00:00Z"; // 23:00 local, the 17th

describe("the local day", () => {
  test("the zone really is set (guards the rest of the file)", () => {
    expect(evening.getHours()).toBe(21);
  });

  test("localDayOf: an evening timestamp belongs to that evening's day", () => {
    expect(localDayOf(earlierThisEvening)).toBe("2026-05-18");
    expect(localDayOf(lastNight)).toBe("2026-05-17");
    expect(localDayOf("not a date")).toBeNull();
  });

  test("lastLocalDays: oldest first, ending today, across the spring DST change", () => {
    expect(lastLocalDays(evening, 3)).toEqual(["2026-05-16", "2026-05-17", "2026-05-18"]);
    // 2026-03-08 is the US spring-forward day.
    expect(lastLocalDays(new Date("2026-03-09T19:00:00Z"), 3)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  });
});

describe("the displays use it", () => {
  test("status card sparkline: this morning and this evening are both today's column", () => {
    // UTC puts thisMorning (the 18th) and earlierThisEvening (the 19th) in different columns.
    const out = buildSparkline([earlierThisEvening, thisMorning], evening, 7);
    expect(out[6]).toBe("█");
    expect(out[5]).toBe(" ");
  });

  test("report: the daily buckets are local days, this evening counted today", () => {
    const b = bucketByDay([earlierThisEvening, thisMorning, lastNight], evening, 2);
    expect(b).toEqual([
      { dateKey: "2026-05-17", count: 1 },
      { dateKey: "2026-05-18", count: 2 },
    ]);
  });
});
