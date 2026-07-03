import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addXp,
  recordPet,
  recordAction,
  readProgression,
  writeProgression,
  applyStatEffects,
  actionXpToday,
  ACTION_BASE_XP,
  ACTION_XP_DAILY_CAP,
  DEFAULT_PROGRESSION,
  type Progression,
  type Stats,
} from "../../src/state/progression";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-prog-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("DEFAULT_PROGRESSION starts at level 1 with base pose unlocked", () => {
  expect(DEFAULT_PROGRESSION.level).toBe(1);
  expect(DEFAULT_PROGRESSION.xp).toBe(0);
  expect(DEFAULT_PROGRESSION.unlocked_poses).toEqual(["base"]);
});

test("addXp: zero or negative amount returns unchanged", () => {
  const r1 = addXp(DEFAULT_PROGRESSION, 0);
  expect(r1.next.xp).toBe(0);
  expect(r1.delta).toBe(0);
  const r2 = addXp(DEFAULT_PROGRESSION, -10);
  expect(r2.next.xp).toBe(0);
});

test("addXp: simple gain stays under threshold, no level up", () => {
  const r = addXp(DEFAULT_PROGRESSION, 50);
  expect(r.next.xp).toBe(50);
  expect(r.next.level).toBe(1);
  expect(r.leveled_up).toBe(false);
  expect(r.new_unlocks.poses).toEqual([]);
});

test("addXp: crossing threshold levels up + applies unlocks", () => {
  const r = addXp(DEFAULT_PROGRESSION, 110);
  expect(r.next.level).toBe(2);
  expect(r.next.xp).toBe(10);
  expect(r.next.xp_to_next_level).toBe(200);
  expect(r.leveled_up).toBe(true);
  expect(r.new_unlocks.poses).toEqual(["peek"]);
  expect(r.new_unlocks.titles).toEqual(["Watcher"]);
});

test("addXp: multi-level on a big amount", () => {
  // 100 (lv1→2) + 200 (lv2→3) + 50 = 350 total xp, leaves 50 on level 3
  const r = addXp(DEFAULT_PROGRESSION, 350);
  expect(r.next.level).toBe(3);
  expect(r.next.xp).toBe(50);
  expect(r.next.unlocked_poses).toContain("peek");
  expect(r.next.unlocked_poses).toContain("blink");
});

test("recordPet: within cap awards XP and bumps count", () => {
  const r = recordPet(DEFAULT_PROGRESSION, "2026-05-14");
  expect(r.awarded).toBe(5);
  expect(r.capped).toBe(false);
  expect(r.pets_today).toBe(1);
  expect(r.next.xp).toBe(5);
});

test("recordPet: at cap returns capped + 0 awarded", () => {
  let p: Progression = DEFAULT_PROGRESSION;
  p = recordPet(p, "2026-05-14").next;
  p = recordPet(p, "2026-05-14").next;
  p = recordPet(p, "2026-05-14").next;
  const r = recordPet(p, "2026-05-14");
  expect(r.capped).toBe(true);
  expect(r.awarded).toBe(0);
  expect(r.next.xp).toBe(p.xp);
});

test("recordPet: new day resets daily count", () => {
  let p: Progression = DEFAULT_PROGRESSION;
  p = recordPet(p, "2026-05-14").next;
  p = recordPet(p, "2026-05-14").next;
  p = recordPet(p, "2026-05-14").next;
  const r = recordPet(p, "2026-05-15");
  expect(r.awarded).toBe(5);
  expect(r.pets_today).toBe(1);
});

test("recordPet: pet_log trimmed to 7 days", () => {
  let p: Progression = DEFAULT_PROGRESSION;
  for (let i = 1; i <= 10; i++) {
    const day = `2026-05-${i.toString().padStart(2, "0")}`;
    p = recordPet(p, day).next;
  }
  expect(p.pet_log).toHaveLength(7);
  expect(p.pet_log[0]?.day).toBe("2026-05-04");
  expect(p.pet_log[6]?.day).toBe("2026-05-10");
});

test("readProgression: returns defaults when file missing", async () => {
  const p = await readProgression(tmp);
  expect(p.level).toBe(1);
  expect(p.xp).toBe(0);
});

test("readProgression: returns defaults on malformed JSON", async () => {
  writeFileSync(join(tmp, "progression.json"), "not json");
  const p = await readProgression(tmp);
  expect(p.schemaVersion).toBe(2);
  expect(p.level).toBe(1);
  expect(p.xp).toBe(0);
  expect(p.streak_days_persistent).toBe(0);
  expect(p.streak_last_day).toBeNull();
  expect(p.stats).toEqual(DEFAULT_PROGRESSION.stats);
});

test("recordPet does not mutate input progression (immutability)", () => {
  const original: Progression = {
    ...DEFAULT_PROGRESSION,
    pet_log: [{ day: "2026-05-14", count: 1 }],
  };
  const snapshot = JSON.parse(JSON.stringify(original));
  recordPet(original, "2026-05-14");
  expect(original).toEqual(snapshot);
});

test("pet_log keeps chronological order under non-sorted inserts", () => {
  let p: Progression = DEFAULT_PROGRESSION;
  // Insert days out of order
  p = recordPet(p, "2026-05-20").next;
  p = recordPet(p, "2026-05-15").next;
  p = recordPet(p, "2026-05-25").next;
  p = recordPet(p, "2026-05-10").next;
  // After all inserts, pet_log should be ascending by day
  const days = p.pet_log.map((d) => d.day);
  expect(days).toEqual([...days].sort());
});

test("write+read round-trips progression (v2)", async () => {
  const custom: Progression = {
    schemaVersion: 2,
    level: 3,
    xp: 42,
    xp_to_next_level: 300,
    unlocked_poses: ["base", "peek", "blink"],
    unlocked_titles: ["Hatchling", "Watcher"],
    pet_log: [{ day: "2026-05-14", count: 2 }],
    daily_actions: [],
    stats: { hp: 10, hunger: 5, energy: 8, mood: 6, bond: 0 },
    stats_last_tick_at: "2026-05-14T12:00:00.000Z",
    streak_days_persistent: 1,
    streak_last_day: "2026-05-14",
  };
  await writeProgression(tmp, custom);
  const got = await readProgression(tmp);
  expect(got).toEqual(custom);
});

test("readProgression: v1 file migrates to v2 with default stats", async () => {
  const v1 = {
    schemaVersion: 1,
    level: 2,
    xp: 50,
    xp_to_next_level: 200,
    unlocked_poses: ["base", "peek"],
    unlocked_titles: ["Hatchling", "Watcher"],
    pet_log: [{ day: "2026-05-10", count: 1 }, { day: "2026-05-11", count: 2 }],
    daily_actions: [],
  };
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(tmp, "progression.json"), JSON.stringify(v1), "utf8");
  const got = await readProgression(tmp);
  expect(got.schemaVersion).toBe(2);
  // Default stats applied
  expect(got.stats.hp).toBe(10);
  expect(got.stats.hunger).toBe(5);
  expect(got.stats.energy).toBe(8);
  expect(got.stats.mood).toBe(6);
  expect(got.stats.bond).toBe(0);
  // streak derived from pet_log (2 entries → min(7, 2) = 2)
  expect(got.streak_days_persistent).toBe(2);
  // last pet_log day used as streak_last_day
  expect(got.streak_last_day).toBe("2026-05-11");
  // Original fields preserved
  expect(got.level).toBe(2);
  expect(got.xp).toBe(50);
});

test("readProgression: v2 file with valid stats reads unchanged (round-trip)", async () => {
  const v2 = {
    schemaVersion: 2,
    level: 5,
    xp: 999,
    xp_to_next_level: 1250,
    unlocked_poses: ["base"],
    unlocked_titles: ["Hatchling"],
    pet_log: [],
    daily_actions: [],
    stats: { hp: 7, hunger: 4, energy: 6, mood: 5, bond: 3 },
    stats_last_tick_at: "2026-05-18T10:00:00.000Z",
    streak_days_persistent: 5,
    streak_last_day: "2026-05-17",
  };
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(tmp, "progression.json"), JSON.stringify(v2), "utf8");
  const got = await readProgression(tmp);
  expect(got.schemaVersion).toBe(2);
  expect(got.stats.hp).toBe(7);
  expect(got.stats.hunger).toBe(4);
  expect(got.streak_days_persistent).toBe(5);
  expect(got.streak_last_day).toBe("2026-05-17");
});

test("readProgression: v2 file with missing stats field migrates to defaults", async () => {
  const v2BadStats = {
    schemaVersion: 2,
    level: 3,
    xp: 0,
    xp_to_next_level: 300,
    unlocked_poses: ["base"],
    unlocked_titles: ["Hatchling"],
    pet_log: [],
    daily_actions: [],
    // stats intentionally missing
    stats_last_tick_at: "2026-05-18T10:00:00.000Z",
    streak_days_persistent: 3,
    streak_last_day: "2026-05-17",
  };
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(tmp, "progression.json"), JSON.stringify(v2BadStats), "utf8");
  const got = await readProgression(tmp);
  expect(got.schemaVersion).toBe(2);
  expect(got.stats.hp).toBe(10);
  expect(got.stats.hunger).toBe(5);
});

// ── applyStatEffects ────────────────────────────────────────────────────────

const BASE_STATS: Stats = { hp: 5, hunger: 5, energy: 5, mood: 5, bond: 5 };

test("applyStatEffects: feed raises hunger +3 and mood +1", () => {
  const result = applyStatEffects(BASE_STATS, "feed");
  expect(result.hunger).toBe(8);
  expect(result.mood).toBe(6);
  // unchanged fields
  expect(result.hp).toBe(5);
  expect(result.energy).toBe(5);
  expect(result.bond).toBe(5);
});

test("applyStatEffects: play lowers hunger -1, energy -2, raises mood +2, bond +1", () => {
  const result = applyStatEffects(BASE_STATS, "play");
  expect(result.hunger).toBe(4);
  expect(result.energy).toBe(3);
  expect(result.mood).toBe(7);
  expect(result.bond).toBe(6);
  expect(result.hp).toBe(5);
});

test("applyStatEffects: clean raises hp +1, mood +1", () => {
  const result = applyStatEffects(BASE_STATS, "clean");
  expect(result.hp).toBe(6);
  expect(result.mood).toBe(6);
});

test("applyStatEffects: pet raises mood +1, bond +2", () => {
  const result = applyStatEffects(BASE_STATS, "pet");
  expect(result.mood).toBe(6);
  expect(result.bond).toBe(7);
});

test("applyStatEffects: sleep raises hp +1, energy +4", () => {
  const result = applyStatEffects(BASE_STATS, "sleep");
  expect(result.hp).toBe(6);
  expect(result.energy).toBe(9);
});

test("applyStatEffects: tease lowers mood -2, bond -1", () => {
  const result = applyStatEffects(BASE_STATS, "tease");
  expect(result.mood).toBe(3);
  expect(result.bond).toBe(4);
});

test("applyStatEffects: clamps at upper bound 10", () => {
  const near10: Stats = { hp: 10, hunger: 10, energy: 10, mood: 10, bond: 10 };
  const result = applyStatEffects(near10, "feed");
  expect(result.hunger).toBe(10);  // clamped from 13
  expect(result.mood).toBe(10);    // clamped from 11
});

test("applyStatEffects: clamps at lower bound 0", () => {
  const near0: Stats = { hp: 0, hunger: 0, energy: 0, mood: 0, bond: 0 };
  const result = applyStatEffects(near0, "tease");
  expect(result.mood).toBe(0);     // clamped from -2
  expect(result.bond).toBe(0);     // clamped from -1
});

test("applyStatEffects: pure — does not mutate input stats", () => {
  const snap = { ...BASE_STATS };
  applyStatEffects(BASE_STATS, "feed");
  expect(BASE_STATS).toEqual(snap);
});

// ── streak update via recordAction ─────────────────────────────────────────

test("recordAction: first action ever → streak=1, streak_last_day=today", () => {
  const prog = { ...DEFAULT_PROGRESSION, streak_days_persistent: 0, streak_last_day: null };
  const result = recordAction(prog, "2026-05-18", "pet");
  expect(result.next.streak_days_persistent).toBe(1);
  expect(result.next.streak_last_day).toBe("2026-05-18");
});

test("recordAction: action today + action today → streak unchanged (idempotent)", () => {
  const prog = { ...DEFAULT_PROGRESSION, streak_days_persistent: 3, streak_last_day: "2026-05-18" };
  const result = recordAction(prog, "2026-05-18", "pet");
  expect(result.next.streak_days_persistent).toBe(3);
  expect(result.next.streak_last_day).toBe("2026-05-18");
});

test("recordAction: action yesterday + action today → streak increments", () => {
  const prog = { ...DEFAULT_PROGRESSION, streak_days_persistent: 3, streak_last_day: "2026-05-17" };
  const result = recordAction(prog, "2026-05-18", "pet");
  expect(result.next.streak_days_persistent).toBe(4);
  expect(result.next.streak_last_day).toBe("2026-05-18");
});

test("recordAction: gap > 1 day → streak resets to 1", () => {
  const prog = { ...DEFAULT_PROGRESSION, streak_days_persistent: 10, streak_last_day: "2026-05-10" };
  const result = recordAction(prog, "2026-05-18", "pet");
  expect(result.next.streak_days_persistent).toBe(1);
  expect(result.next.streak_last_day).toBe("2026-05-18");
});

// ── Awarded ledger (single price table) ──────────────────────────────────────

test("ACTION_BASE_XP is the single price table (play 3, tease 0)", () => {
  expect(ACTION_BASE_XP.feed).toBe(5);
  expect(ACTION_BASE_XP.play).toBe(3);
  expect(ACTION_BASE_XP.pet).toBe(5);
  expect(ACTION_BASE_XP.tease).toBe(0);
  expect(ACTION_BASE_XP.clean).toBe(5);
  expect(ACTION_BASE_XP.sleep).toBe(0);
});

test("ACTION_XP_DAILY_CAP is 100", () => {
  expect(ACTION_XP_DAILY_CAP).toBe(100);
});

test("actionXpToday: no ledger entry for the day → 0", () => {
  const prog = { ...DEFAULT_PROGRESSION, action_xp: [{ day: "2026-05-17", xp: 40 }] };
  expect(actionXpToday(prog, "2026-05-18")).toBe(0);
});

test("actionXpToday: returns the ledger value for the day", () => {
  const prog = { ...DEFAULT_PROGRESSION, action_xp: [{ day: "2026-05-18", xp: 37 }] };
  expect(actionXpToday(prog, "2026-05-18")).toBe(37);
});

test("actionXpToday: reflects XP awarded by recordAction (same ledger)", () => {
  const r1 = recordAction(DEFAULT_PROGRESSION, "2026-05-18", "play");
  const r2 = recordAction(r1.next, "2026-05-18", "feed");
  expect(actionXpToday(r2.next, "2026-05-18")).toBe(
    ACTION_BASE_XP.play + ACTION_BASE_XP.feed,
  );
});
