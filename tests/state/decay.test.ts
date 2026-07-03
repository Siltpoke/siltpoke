/**
 * Tests for decay.ts — applyDecay + tickDecay
 */
import { test, expect, describe } from "bun:test";
import { applyDecay, DECAY_RATES_PER_HOUR } from "../../src/state/decay";
import { tickDecay } from "../../src/state/decay";
import type { Stats } from "../../src/state/progression";
import { DEFAULT_PROGRESSION } from "../../src/state/progression";

const FULL_STATS: Stats = { hp: 10, hunger: 10, energy: 10, mood: 10, bond: 10 };

describe("DECAY_RATES_PER_HOUR", () => {
  test("hp and bond decay rates are 0", () => {
    expect(DECAY_RATES_PER_HOUR.hp).toBe(0);
    expect(DECAY_RATES_PER_HOUR.bond).toBe(0);
  });

  test("hunger, energy, mood have positive decay rates", () => {
    expect(DECAY_RATES_PER_HOUR.hunger).toBeGreaterThan(0);
    expect(DECAY_RATES_PER_HOUR.energy).toBeGreaterThan(0);
    expect(DECAY_RATES_PER_HOUR.mood).toBeGreaterThan(0);
  });
});

describe("applyDecay", () => {
  test("0 hours elapsed returns unchanged stats", () => {
    const result = applyDecay(FULL_STATS, 0);
    expect(result).toEqual(FULL_STATS);
  });

  test("negative hours elapsed returns unchanged stats", () => {
    const result = applyDecay(FULL_STATS, -5);
    expect(result).toEqual(FULL_STATS);
  });

  test("1 hour: hunger decreases by 0.5", () => {
    const result = applyDecay(FULL_STATS, 1);
    expect(result.hunger).toBeCloseTo(10 - 0.5, 5);
  });

  test("1 hour: energy decreases by 0.3", () => {
    const result = applyDecay(FULL_STATS, 1);
    expect(result.energy).toBeCloseTo(10 - 0.3, 5);
  });

  test("1 hour: mood decreases by 0.2", () => {
    const result = applyDecay(FULL_STATS, 1);
    expect(result.mood).toBeCloseTo(10 - 0.2, 5);
  });

  test("1 hour: hp and bond unchanged (decay rate 0)", () => {
    const result = applyDecay(FULL_STATS, 1);
    expect(result.hp).toBe(10);
    expect(result.bond).toBe(10);
  });

  test("4 hours: hunger decreases by 4 * 0.5 = 2", () => {
    const result = applyDecay(FULL_STATS, 4);
    expect(result.hunger).toBeCloseTo(10 - 4 * 0.5, 5);
  });

  test("4 hours: mood decreases by 4 * 0.2 = 0.8", () => {
    const result = applyDecay(FULL_STATS, 4);
    expect(result.mood).toBeCloseTo(10 - 4 * 0.2, 5);
  });

  test("clamps values to 0 (no negative stats)", () => {
    const lowStats: Stats = { hp: 0, hunger: 0.1, energy: 0.1, mood: 0.1, bond: 0 };
    const result = applyDecay(lowStats, 1);
    expect(result.hunger).toBe(0);
    expect(result.energy).toBe(0);
    expect(result.mood).toBe(0);
  });

  test("clamps values to 10 (no overflow)", () => {
    // hp starts at 10 and doesn't decay, should stay 10
    const result = applyDecay(FULL_STATS, 0.1);
    expect(result.hp).toBe(10);
    expect(result.bond).toBe(10);
  });

  test("hunger=0 starvation: mood gets extra -0.5/hr penalty", () => {
    const starving: Stats = { hp: 10, hunger: 0, energy: 10, mood: 5, bond: 0 };
    const result = applyDecay(starving, 1);
    // Normal mood decay = 0.2/hr, starvation extra = 0.5/hr → total 0.7/hr
    expect(result.mood).toBeCloseTo(5 - 0.7, 5);
  });

  test("hunger=0 starvation over 4 hours: mood extra penalty accumulates", () => {
    const starving: Stats = { hp: 10, hunger: 0, energy: 10, mood: 10, bond: 0 };
    const result = applyDecay(starving, 4);
    // Normal: 10 - 0.2*4 = 9.2. Starvation extra: 0.5*4 = 2. Total = 7.2
    expect(result.mood).toBeCloseTo(10 - 0.2 * 4 - 0.5 * 4, 5);
  });

  test("hunger > 0 (not starving) has no extra mood penalty", () => {
    const notStarving: Stats = { hp: 10, hunger: 1, energy: 10, mood: 5, bond: 0 };
    const result = applyDecay(notStarving, 1);
    // Only regular 0.2/hr mood decay
    expect(result.mood).toBeCloseTo(5 - 0.2, 5);
  });

  test("immutable — does not mutate input stats", () => {
    const snap = { ...FULL_STATS };
    applyDecay(FULL_STATS, 2);
    expect(FULL_STATS).toEqual(snap);
  });
});

describe("tickDecay", () => {
  test("advances stats_last_tick_at to now", () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats: { ...FULL_STATS },
      stats_last_tick_at: "2026-05-18T11:00:00.000Z",
    };
    const result = tickDecay(prog, now);
    expect(result.stats_last_tick_at).toBe("2026-05-18T12:00:00.000Z");
  });

  test("applies 1hr decay to hunger", () => {
    const last = new Date("2026-05-18T11:00:00.000Z");
    const now  = new Date("2026-05-18T12:00:00.000Z");
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats: { ...FULL_STATS },
      stats_last_tick_at: last.toISOString(),
    };
    const result = tickDecay(prog, now);
    expect(result.stats.hunger).toBeCloseTo(10 - 0.5, 5);
  });

  test("0 hours elapsed changes only stats_last_tick_at", () => {
    const now = new Date("2026-05-18T12:00:00.000Z");
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats: { ...FULL_STATS },
      stats_last_tick_at: now.toISOString(),
    };
    const result = tickDecay(prog, now);
    expect(result.stats).toEqual(FULL_STATS);
    expect(result.stats_last_tick_at).toBe(now.toISOString());
  });

  test("multiple pokes do not double-apply decay for same window", () => {
    const last = new Date("2026-05-18T10:00:00.000Z");
    const mid  = new Date("2026-05-18T11:00:00.000Z");
    const now  = new Date("2026-05-18T12:00:00.000Z");
    let prog = {
      ...DEFAULT_PROGRESSION,
      stats: { ...FULL_STATS },
      stats_last_tick_at: last.toISOString(),
    };
    prog = tickDecay(prog, mid);   // apply 1hr of decay
    prog = tickDecay(prog, now);   // apply another 1hr of decay

    // Total: 2hrs hunger decay = -1.0
    expect(prog.stats.hunger).toBeCloseTo(10 - 1.0, 4);
  });
});
