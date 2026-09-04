/**
 * Tests for Home.data.ts — getHomeData() resolver core fields.
 *
 * Strategy: Option A (tmp-dir filesystem). Each test writes minimal fixture
 * files to a mkdtempSync directory and points basePath at it — matching the
 * pattern used in tests/memory/memory.test.ts.
 *
 * pure-helper tests moved to Home.data.helpers.test.ts.
 * HomeData shape + edge-case tests moved to Home.data.shape.test.ts.
 * Shared writeFixtures helper lives in _home-data-fixtures.ts.
 *
 * Home data loader tests.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getHomeData, type HomeDeps } from "../../../src/web/screens/Home.data";
import { writeHomeFixtures, HOME_DATA_NOW as NOW } from "./_home-data-fixtures";
import {
  freshBrainHealth,
  recordFailure,
  recordSuccess,
  writeBrainHealth,
} from "../../../src/state/brain-health";

// ── getHomeData happy-path — core fields ───────────────────────────────────

describe("getHomeData", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-home-data-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns correct pet shape", async () => {
    writeHomeFixtures(tmp, {});
    const deps: HomeDeps = { basePath: tmp, now: NOW };
    const data = await getHomeData(deps);
    expect(data.pet.name).toBe("Bangbang");
    expect(data.pet.species).toBe("cat");
    expect(data.pet.level).toBe(3);
    expect(["neutral", "happy", "hungry", "sleepy", "sad", "poke", "snark", "wow"]).toContain(
      data.pet.mood,
    );
  });

  test("returns correct progression shape", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.progression.xp).toBe(240);
    expect(data.progression.xp_to_next).toBe(500);
    expect(data.progression.streak_days).toBe(3); // pet_log has 3 entries
    expect(data.progression.together_time).toBe("3 days");
  });

  test("statusline contains species and level", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.statusline).toContain("cat");
    expect(data.statusline).toContain("3");
    expect(data.statusline).toContain("siltpoke");
  });

  // vitals series are zero-padded 7-element arrays read from vitals.jsonl.
  // No vitals.jsonl present in fixture → all zeros, length 7.
  test("vitals.mood is length-7 array (zeros when no vitals.jsonl)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.vitals.mood).toHaveLength(7);
    expect(data.vitals.mood.every((v) => v === 0)).toBe(true);
  });

  test("vitals.hunger is length-7 array (zeros when no vitals.jsonl)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.vitals.hunger).toHaveLength(7);
    expect(data.vitals.hunger.every((v) => v === 0)).toBe(true);
  });

  test("vitals.energy is length-7 array (zeros when no vitals.jsonl)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.vitals.energy).toHaveLength(7);
    expect(data.vitals.energy.every((v) => v === 0)).toBe(true);
  });

  test("vitals.bond is length-7 array (zeros when no vitals.jsonl)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.vitals.bond).toHaveLength(7);
    expect(data.vitals.bond.every((v) => v === 0)).toBe(true);
  });

  test("vitalsValues has all 4 keys (mood/hunger/energy/bond)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(typeof data.vitalsValues.mood).toBe("string");
    expect(typeof data.vitalsValues.hunger).toBe("string");
    expect(typeof data.vitalsValues.energy).toBe("string");
    expect(typeof data.vitalsValues.bond).toBe("string");
  });

  // v2 progression fixture — readProgression preserves action_xp only on
  // non-migrated (schemaVersion 2, full stats) files, matching what
  // recordAction actually persists.
  const v2ProgressionWithLedger = (opts: {
    daily_actions: unknown[];
    action_xp: unknown[];
  }): Record<string, unknown> => ({
    schemaVersion: 2,
    level: 3,
    xp: 240,
    xp_to_next_level: 500,
    unlocked_poses: ["base"],
    unlocked_titles: [],
    pet_log: [],
    daily_actions: opts.daily_actions,
    action_xp: opts.action_xp,
    stats: { hp: 8, hunger: 5, energy: 7, mood: 6, bond: 4 },
    stats_last_tick_at: "2026-05-18T12:00:00Z",
    streak_days_persistent: 1,
    streak_last_day: "2026-05-18",
  });

  test("xp.xpToday reads the awarded ledger (action_xp), not daily_actions counts", async () => {
    writeHomeFixtures(tmp, {
      progression: v2ProgressionWithLedger({
        // Counts alone would price to a different number than the ledger —
        // the badge must show the ledger value.
        daily_actions: [{ day: "2026-05-18", feed: 1, play: 0, pet: 1, tease: 0 }],
        action_xp: [{ day: "2026-05-18", xp: 37 }],
      }),
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.xp.xpToday).toBe(37);
    expect(data.xp.xpTodayCapped).toBe(false);
  });

  test("xp.xpTodayCapped is true when the ledger hits the daily cap", async () => {
    writeHomeFixtures(tmp, {
      progression: v2ProgressionWithLedger({
        daily_actions: [{ day: "2026-05-18", feed: 5, play: 5, pet: 5, tease: 0 }],
        action_xp: [{ day: "2026-05-18", xp: 100 }],
      }),
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.xp.xpToday).toBe(100);
    expect(data.xp.xpTodayCapped).toBe(true);
  });

  test("xp.xpToday is 0 when the ledger has no entry for today", async () => {
    // Default fixture has daily_actions for today but NO action_xp ledger —
    // a count-based recompute would show 10 here; the honest value is 0.
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.xp.xpToday).toBe(0);
    expect(data.xp.xpTodayCapped).toBe(false);
  });

  test("vitalsValues.hunger is 'fed' when today has feed > 0", async () => {
    // Fixture has feed:1 on 2026-05-18
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.vitalsValues.hunger).toBe("fed");
  });

  test("vitalsValues.energy is numeric display from real stats", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    // Real stats: energy from progression.stats.energy/10 format
    expect(data.vitalsValues.energy).toMatch(/^\d+\/10$/);
  });

  test("vitalsValues.bond is numeric display from real stats", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    // Real stats: bond from progression.stats.bond/10 format
    expect(data.vitalsValues.bond).toMatch(/^\d+\/10$/);
  });

  test("vitalsValues.mood is a Mood string (happy/hungry/neutral)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(["happy", "hungry", "neutral", "sleepy", "sad", "poke", "snark", "wow"]).toContain(
      data.vitalsValues.mood,
    );
  });

  test("vitalsValues.hunger is 'hungry' when today has no feed", async () => {
    writeHomeFixtures(tmp, {
      progression: {
        schemaVersion: 1,
        level: 1,
        xp: 0,
        xp_to_next_level: 100,
        unlocked_poses: ["base"],
        unlocked_titles: ["Hatchling"],
        pet_log: [],
        daily_actions: [
          { day: "2026-05-18", feed: 0, play: 1, pet: 0, tease: 0 },
        ],
      },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.vitalsValues.hunger).toBe("hungry");
  });

  test("facts returns at most 10 most recent by created_at desc", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.facts.length).toBeLessThanOrEqual(10);
    // Most recent fact first
    if (data.facts.length >= 2) {
      expect(data.facts[0]?.created_at >= data.facts[1]?.created_at).toBe(true);
    }
  });

  test("topbarBadges.wellFed is true when today has feed > 0", async () => {
    // Fixture has feed:1 on 2026-05-18
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.topbarBadges.wellFed).toBe(true);
  });

  test("topbarBadges.wellFed is false when today has no feed", async () => {
    writeHomeFixtures(tmp, {
      progression: {
        schemaVersion: 1,
        level: 1,
        xp: 0,
        xp_to_next_level: 100,
        unlocked_poses: ["base"],
        unlocked_titles: ["Hatchling"],
        pet_log: [],
        daily_actions: [
          { day: "2026-05-18", feed: 0, play: 1, pet: 0, tease: 0 },
        ],
      },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.topbarBadges.wellFed).toBe(false);
  });

  test("topbarBadges.sinceDressed is terse duration (no 'since dressed' suffix — composed at renderer)", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.topbarBadges.sinceDressed).not.toContain("since dressed");
    // Either "never" or matches a duration unit like "8 mins" / "22 hrs" / "3 days".
    expect(data.topbarBadges.sinceDressed).toMatch(/^(never|\d+ (min|mins|hr|hrs|day|days))$/);
  });

  test("topbarBadges.todayCount counts facts created today", async () => {
    // Fixture has 1 fact with created_at 2026-05-18T10:00:00Z
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.topbarBadges.todayCount).toBe(1);
  });

  test("handles missing files gracefully (no progression.json, no memory.json)", async () => {
    // Only config.json
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ name: "ghost", species: "slime" }), "utf8");
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.pet.name).toBe("ghost");
    expect(data.pet.species).toBe("slime");
    expect(data.progression.streak_days).toBe(0);
    expect(data.progression.together_time).toBe("0 days");
    expect(data.facts).toEqual([]);
    // vitals series are 7 zeros when no vitals.jsonl
    expect(data.vitals.mood).toHaveLength(7);
    expect(data.vitals.hunger).toHaveLength(7);
    expect(data.vitals.energy).toHaveLength(7);
    expect(data.vitals.bond).toHaveLength(7);
    // stats is always present (non-null), defaults to DEFAULT_STATS
    expect(data.stats).not.toBeNull();
    expect(typeof data.stats.hp).toBe("number");
  });

  test("defaults to slime species for unknown species value", async () => {
    writeHomeFixtures(tmp, { config: { name: "X", species: "dragon" /* not in KNOWN_SPECIES */ } });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.pet.species).toBe("slime");
  });

  test("defaults to siltpoke name when config has no name", async () => {
    writeHomeFixtures(tmp, { config: { species: "cat" } });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.pet.name).toBe("siltpoke");
  });

  // vitals series are 7-element zero-padded arrays read from vitals.jsonl.
  // vitalsValues.hunger derives from daily_actions (wellFed check).
  test("vitals shape is 7-element zero arrays when no vitals.jsonl", async () => {
    writeHomeFixtures(tmp, {
      progression: {
        schemaVersion: 2,
        level: 1,
        xp: 10,
        xp_to_next_level: 100,
        unlocked_poses: ["base"],
        unlocked_titles: ["Hatchling"],
        pet_log: [{ day: "2026-05-18", count: 1 }],
        daily_actions: [
          { day: "2026-05-18", feed: 1, play: 0, pet: 1, tease: 0, clean: 0, sleep: 0 },
        ],
        stats: { hp: 10, hunger: 5, energy: 8, mood: 6, bond: 0 },
        stats_last_tick_at: "2026-05-18T10:00:00.000Z",
        streak_days_persistent: 1,
        streak_last_day: "2026-05-18",
      },
    });
    const data = await getHomeData({ basePath: tmp, now: NOW });
    // All series are 7-element zero-padded (no vitals.jsonl)
    expect(data.vitals.mood).toHaveLength(7);
    expect(data.vitals.hunger).toHaveLength(7);
    // well-fed derives correctly from daily_actions
    expect(data.vitalsValues.hunger).toBe("fed");
  });
});

// ── brainHealth strip data ─────────────────────────────────

describe("getHomeData — brainHealth", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-home-brainhealth-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("unhealthy (2 consecutive failures, recent) → strip data present", async () => {
    writeHomeFixtures(tmp, {});
    let h = freshBrainHealth();
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts: NOW.toISOString() });
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts: NOW.toISOString() });
    writeBrainHealth(tmp, h);
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.brainHealth.show).toBe(true);
    expect(data.brainHealth.line).toContain("resource");
  });

  test("healthy (no record / after success) → strip data absent", async () => {
    writeHomeFixtures(tmp, {});
    const data = await getHomeData({ basePath: tmp, now: NOW });
    expect(data.brainHealth.show).toBe(false);

    let h = freshBrainHealth();
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts: NOW.toISOString() });
    h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts: NOW.toISOString() });
    h = recordSuccess(h, NOW.toISOString());
    writeBrainHealth(tmp, h);
    const after = await getHomeData({ basePath: tmp, now: NOW });
    expect(after.brainHealth.show).toBe(false);
  });
});
