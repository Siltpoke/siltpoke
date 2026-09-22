/**
 * Tests for Home.data.ts pure helpers (pad7d, wellFedFromHunger,
 * sinceLastDressed, factsCreatedToday, WELL_FED_HUNGER_THRESHOLD).
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
  wellFedFromHunger,
  sinceLastDressed,
  factsCreatedToday,
  WELL_FED_HUNGER_THRESHOLD,
} from "../../../src/web/screens/Home.data";
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

// ── WELL_FED_HUNGER_THRESHOLD ──────────────────────────────────────────────

describe("WELL_FED_HUNGER_THRESHOLD", () => {
  test("sits on the 0-10 hunger scale, not a duration", () => {
    // Was 6 hours in milliseconds, for a last-fed timestamp the data model
    // never had. Audit defect [3] replaced that stand-in with the hunger stat
    // the simulation really maintains.
    expect(WELL_FED_HUNGER_THRESHOLD).toBe(4);
  });

  test("a new pet starts ABOVE the threshold", () => {
    // src/state/progression.ts seeds stats.hunger at 5. This is the case that
    // produced the defect: the badge said well-fed, the mood said hungry. Both
    // now read this one predicate, so a new pet reads well-fed on both.
    expect(wellFedFromHunger(5)).toBe(true);
  });
});

// ── wellFedFromHunger ──────────────────────────────────────────────────────

describe("wellFedFromHunger", () => {
  test("above the threshold → true", () => {
    expect(wellFedFromHunger(10)).toBe(true);
    expect(wellFedFromHunger(4.0001)).toBe(true);
  });

  test("at the threshold → false (strictly greater, not >=)", () => {
    expect(wellFedFromHunger(4)).toBe(false);
  });

  test("below the threshold → false", () => {
    expect(wellFedFromHunger(0)).toBe(false);
    expect(wellFedFromHunger(3.9999)).toBe(false);
  });

  test("the sandbox value that exposed the defect resolves one way only", () => {
    // The audit measured hunger 4.9166… on a fresh sandbox install while
    // daily_actions was []. Under the old split that was well-fed AND hungry.
    expect(wellFedFromHunger(4.9166666)).toBe(true);
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
