/**
 * Tests for Home.data.ts — getHomeData() shape comprehensive + navMeta /
 * meta / xp / statuslinePreview.
 *
 * peeled from Home.data.test.ts so each file stays under
 * the 400 LOC warn threshold. Companion files:
 *  - tests/web/screens/Home.data.test.ts — getHomeData() core fields.
 *  - tests/web/screens/Home.data.helpers.test.ts — pure helper tests.
 *  - tests/web/screens/_home-data-fixtures.ts — shared fixture writer.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getHomeData } from "../../../src/web/screens/Home.data";
import { writeHomeFixtures, HOME_DATA_NOW as NOW } from "./_home-data-fixtures";

describe("getHomeData shape + meta", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-home-data-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("HomeData shape has all required top-level keys (Wave 1.5b)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    // Exhaustive key check — extended shape
    expect("pet" in data).toBe(true);
    expect("progression" in data).toBe(true);
    expect("statusline" in data).toBe(true);
    expect("statuslinePreview" in data).toBe(true);
    expect("vitals" in data).toBe(true);
    expect("vitalsValues" in data).toBe(true);
    expect("stats" in data).toBe(true);
    expect("xp" in data).toBe(true);
    expect("facts" in data).toBe(true);
    expect("topbarBadges" in data).toBe(true);
    expect("meta" in data).toBe(true);
    expect("together" in data).toBe(true);
    expect("petTitle" in data).toBe(true);
    expect("navMeta" in data).toBe(true);
    // Nested keys — pet
    expect("name" in data.pet).toBe(true);
    expect("species" in data.pet).toBe(true);
    expect("mood" in data.pet).toBe(true);
    expect("level" in data.pet).toBe(true);
    // Nested keys — progression
    expect("xp" in data.progression).toBe(true);
    expect("xp_to_next" in data.progression).toBe(true);
    expect("streak_days" in data.progression).toBe(true);
    expect("together_time" in data.progression).toBe(true);
    // Nested keys — vitals (7-element arrays from vitals.jsonl)
    expect("mood" in data.vitals).toBe(true);
    expect("hunger" in data.vitals).toBe(true);
    expect("energy" in data.vitals).toBe(true);
    expect("bond" in data.vitals).toBe(true);
    // Nested keys — vitalsValues
    expect("mood" in data.vitalsValues).toBe(true);
    expect("hunger" in data.vitalsValues).toBe(true);
    expect("energy" in data.vitalsValues).toBe(true);
    expect("bond" in data.vitalsValues).toBe(true);
    // stats is always present (real hp/hunger/energy/mood/bond model)
    expect(data.stats).not.toBeNull();
    expect(typeof data.stats.hp).toBe("number");
    expect(typeof data.stats.hunger).toBe("number");
    // Nested keys — xp (includes xpToday + xpTodayCapped)
    expect("level" in data.xp).toBe(true);
    expect("nextLevel" in data.xp).toBe(true);
    expect("xp" in data.xp).toBe(true);
    expect("xpToNext" in data.xp).toBe(true);
    expect("xpToday" in data.xp).toBe(true);
    expect("xpTodayCapped" in data.xp).toBe(true);
    // xpAwardedSeries top-level field
    expect("xpAwardedSeries" in data).toBe(true);
    expect(Array.isArray(data.xpAwardedSeries)).toBe(true);
    // Nested keys — topbarBadges
    expect("wellFed" in data.topbarBadges).toBe(true);
    expect("sinceDressed" in data.topbarBadges).toBe(true);
    expect("todayCount" in data.topbarBadges).toBe(true);
    // Nested keys — meta
    expect("snarkPercent" in data.meta).toBe(true);
    expect("lastPokeAt" in data.meta).toBe(true);
    // Nested keys — navMeta (chat removed — floating chat replaces standalone tab)
    expect("memory" in data.navMeta).toBe(true);
  });

  test("stats is real hp/hunger/energy/mood/bond model", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    // real stats model always present (migrated from v1 fixture to v2 defaults)
    expect(data.stats).not.toBeNull();
    expect(typeof data.stats.hp).toBe("number");
    expect(typeof data.stats.hunger).toBe("number");
    expect(typeof data.stats.energy).toBe("number");
    expect(typeof data.stats.mood).toBe("number");
    expect(typeof data.stats.bond).toBe("number");
  });

  test("xp shape matches progression values", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.xp.xp).toBe(240);
    expect(data.xp.xpToNext).toBe(500);
    expect(data.xp.level).toBe(3);
    expect(data.xp.nextLevel).toBe(4);
  });

  test("statuslinePreview is a multi-line string containing level info", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(typeof data.statuslinePreview).toBe("string");
    expect(data.statuslinePreview).toContain("siltpoke");
    expect(data.statuslinePreview.split("\n").length).toBeGreaterThan(1);
  });

  test("navMeta.memory is '2 facts' when fixture has 2 facts", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    // Default fixture has 2 facts
    expect(data.navMeta.memory).toBe("2 facts");
  });

  test("navMeta.memory is null when no facts", async () => {
    writeHomeFixtures(tmp, {
      memory: {
        schemaVersion: 2,
        long_term_summary: "",
        learned_rules: [],
        personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
        last_consolidated_at: "2026-05-18T00:00:00Z",
        consolidation_due_at: "2026-05-25T00:00:00Z",
        user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
        chat_sessions: [],
        facts: [],
      },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.navMeta.memory).toBeNull();
  });

  test("navMeta.memory is '1 fact' (singular) when 1 fact", async () => {
    writeHomeFixtures(tmp, {
      memory: {
        schemaVersion: 2,
        long_term_summary: "",
        learned_rules: [],
        personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
        last_consolidated_at: "2026-05-18T00:00:00Z",
        consolidation_due_at: "2026-05-25T00:00:00Z",
        user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
        chat_sessions: [],
        facts: [
          {
            id: "f1", text: "x", source_session_id: null, confidence: 1, status: "active",
            created_at: "2026-05-18T10:00:00Z", last_seen_at: "2026-05-18T10:00:00Z",
            supersedes: null, retired_reason: null,
          },
        ],
      },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.navMeta.memory).toBe("1 fact");
  });

  test("meta wired from real memory + progression", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });

    // snarkPercent: memory.personality_drift.snark default 0 → 50%.
    // Range is [-3, 3] mapped to [5%, 95%].
    expect(data.meta.snarkPercent).toBeGreaterThanOrEqual(0);
    expect(data.meta.snarkPercent).toBeLessThanOrEqual(100);

    // lastPokeAt: pet_log empty in default fixture → "never".
    expect(data.meta.lastPokeAt).toMatch(/^(never|just now|now|\d+(m|h|d|w) ago)$/);

    // together: pet_log length suffix "d" or "0d".
    expect(data.together).toMatch(/^\d+d$/);

    // petTitle: user_profile.name when set, else empty string.
    expect(typeof data.petTitle).toBe("string");
  });
});
