/**
 * Tests for Home.data.ts pure helpers (pad7d, wellFedFromActions,
 * sinceLastDressed, factsCreatedToday, WELL_FED_THRESHOLD_MS).
 *
 * No filesystem — pure-function tests only. Peeled out of Home.data.test.ts
 * in an earlier file split. Companion files:
 *  - tests/web/screens/Home.data.test.ts — getHomeData() core fields.
 *  - tests/web/screens/Home.data.shape.test.ts — getHomeData() shape +
 *    edge cases.
 *  - tests/web/screens/_home-data-fixtures.ts — shared fixture writer
 *    consumed by the two getHomeData test files.
 */
import { test, expect, describe } from "bun:test";

import {
  pad7d,
  wellFedFromActions,
  sinceLastDressed,
  factsCreatedToday,
  WELL_FED_THRESHOLD_MS,
} from "../../../src/web/screens/Home.data";
import type { DailyActions } from "../../../src/state/progression";
import type { Fact } from "../../../src/memory/memory";

// ── pad7d ──────────────────────────────────────────────────────────────────

describe("pad7d", () => {
  test("input length 3 → output length 7 with leading zeros", () => {
    expect(pad7d([1, 2, 3])).toEqual([0, 0, 0, 0, 1, 2, 3]);
  });

  test("input length 10 → output length 7 with tail slice", () => {
    expect(pad7d([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  test("input length 7 → identity (same values, new array)", () => {
    const input = [10, 20, 30, 40, 50, 60, 70];
    const result = pad7d(input);
    expect(result).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(result).not.toBe(input); // new array
  });

  test("empty input → 7 zeros", () => {
    expect(pad7d([])).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("input length 1 → 6 leading zeros then value", () => {
    expect(pad7d([42])).toEqual([0, 0, 0, 0, 0, 0, 42]);
  });

  test("input length 8 → last 7 elements", () => {
    expect(pad7d([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});

// ── WELL_FED_THRESHOLD_MS ──────────────────────────────────────────────────

describe("WELL_FED_THRESHOLD_MS", () => {
  test("equals 6 hours in milliseconds", () => {
    expect(WELL_FED_THRESHOLD_MS).toBe(6 * 60 * 60 * 1000);
  });
});

// ── wellFedFromActions ─────────────────────────────────────────────────────

describe("wellFedFromActions", () => {
  const now = new Date("2026-05-18T14:00:00Z");
  const todayKey = "2026-05-18";
  const yesterdayKey = "2026-05-17";

  test("today.feed > 0 + now today → true", () => {
    const daily: DailyActions[] = [
      { day: todayKey, feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
    ];
    expect(wellFedFromActions(daily, now)).toBe(true);
  });

  test("today.feed = 0 + now today → false", () => {
    const daily: DailyActions[] = [
      { day: todayKey, feed: 0, play: 2, pet: 1, tease: 0, clean: 0, sleep: 0 },
    ];
    expect(wellFedFromActions(daily, now)).toBe(false);
  });

  test("yesterday-only feed entry → false (today threshold, no today entry)", () => {
    const daily: DailyActions[] = [
      { day: yesterdayKey, feed: 2, play: 1, pet: 0, tease: 0, clean: 0, sleep: 0 },
    ];
    expect(wellFedFromActions(daily, now)).toBe(false);
  });

  test("undefined daily_actions → false", () => {
    expect(wellFedFromActions(undefined, now)).toBe(false);
  });

  test("empty daily_actions array → false", () => {
    expect(wellFedFromActions([], now)).toBe(false);
  });

  test("today.feed = 2 (capped) → true", () => {
    const daily: DailyActions[] = [
      { day: todayKey, feed: 2, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
    ];
    expect(wellFedFromActions(daily, now)).toBe(true);
  });
});

// ── sinceLastDressed ───────────────────────────────────────────────────────

describe("sinceLastDressed", () => {
  const now = new Date("2026-05-18T14:00:00Z");

  test("null mtime → 'never'", () => {
    expect(sinceLastDressed(null, now)).toBe("never");
  });

  test("8 minutes ago → '8 mins'", () => {
    const mtime = now.getTime() - 8 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("8 mins");
  });

  test("22 hours ago → '22 hrs'", () => {
    const mtime = now.getTime() - 22 * 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("22 hrs");
  });

  test("3 days ago → '3 days'", () => {
    const mtime = now.getTime() - 3 * 24 * 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("3 days");
  });

  test("0 minutes ago → '0 mins'", () => {
    const mtime = now.getTime();
    expect(sinceLastDressed(mtime, now)).toBe("0 mins");
  });

  test("exactly 60 minutes ago → '1 hr' (singular)", () => {
    const mtime = now.getTime() - 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("1 hr");
  });

  test("exactly 48 hours ago → '2 days'", () => {
    const mtime = now.getTime() - 48 * 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("2 days");
  });

  test("47 hours ago → '47 hrs' (under 48h threshold)", () => {
    const mtime = now.getTime() - 47 * 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("47 hrs");
  });

  test("exactly 1 minute ago → '1 min' (singular)", () => {
    const mtime = now.getTime() - 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("1 min");
  });

  test("exactly 24 hours = 1 day (singular)", () => {
    const mtime = now.getTime() - 24 * 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("24 hrs");
  });

  test("72 hours ago → '3 days' (plural)", () => {
    const mtime = now.getTime() - 72 * 60 * 60_000;
    expect(sinceLastDressed(mtime, now)).toBe("3 days");
  });
});

// ── factsCreatedToday ──────────────────────────────────────────────────────

describe("factsCreatedToday", () => {
  const now = new Date("2026-05-18T14:00:00Z");
  const todayPrefix = "2026-05-18";
  const yesterdayPrefix = "2026-05-17";

  function makeFact(id: string, created_at: string): Fact {
    return {
      id,
      text: `Fact ${id}`,
      source_session_id: null,
      confidence: 0.9,
      status: "active",
      created_at,
      last_seen_at: created_at,
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
    };
  }

  test("2 facts today + 3 facts yesterday → 2", () => {
    const facts: Fact[] = [
      makeFact("f1", `${todayPrefix}T10:00:00Z`),
      makeFact("f2", `${todayPrefix}T12:00:00Z`),
      makeFact("f3", `${yesterdayPrefix}T08:00:00Z`),
      makeFact("f4", `${yesterdayPrefix}T09:00:00Z`),
      makeFact("f5", `${yesterdayPrefix}T11:00:00Z`),
    ];
    expect(factsCreatedToday(facts, now)).toBe(2);
  });

  test("empty facts → 0", () => {
    expect(factsCreatedToday([], now)).toBe(0);
  });

  test("edge: fact at midnight UTC today is counted", () => {
    const facts: Fact[] = [
      makeFact("f1", `${todayPrefix}T00:00:00Z`),
      makeFact("f2", `${todayPrefix}T23:59:59Z`),
    ];
    expect(factsCreatedToday(facts, now)).toBe(2);
  });

  test("edge: fact at 23:59:59 yesterday is NOT counted", () => {
    const facts: Fact[] = [
      makeFact("f1", `${yesterdayPrefix}T23:59:59Z`),
    ];
    expect(factsCreatedToday(facts, now)).toBe(0);
  });

  test("all facts today → all counted", () => {
    const facts: Fact[] = [
      makeFact("f1", `${todayPrefix}T01:00:00Z`),
      makeFact("f2", `${todayPrefix}T02:00:00Z`),
      makeFact("f3", `${todayPrefix}T03:00:00Z`),
    ];
    expect(factsCreatedToday(facts, now)).toBe(3);
  });

  test("no facts today, only yesterday → 0", () => {
    const facts: Fact[] = [
      makeFact("f1", `${yesterdayPrefix}T09:00:00Z`),
    ];
    expect(factsCreatedToday(facts, now)).toBe(0);
  });
});
