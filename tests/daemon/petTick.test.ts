/**
 * Tests for daemon/petTick.ts — pokeOnce with injected clock.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeProgression } from "../../src/state/progression";
import { pokeOnce } from "../../src/daemon/petTick";
import { DEFAULT_PROGRESSION } from "../../src/state/progression";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-pettick-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pokeOnce", () => {
  test("updates stats_last_tick_at to injected now", async () => {
    const tickedAt = "2026-05-18T10:00:00.000Z";
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats_last_tick_at: "2026-05-18T09:00:00.000Z",
    };
    await writeProgression(tmp, prog);

    const now = new Date(tickedAt);
    await pokeOnce({ homeBase: tmp, now: () => now });

    const raw = await readFile(join(tmp, "progression.json"), "utf8");
    const stored = JSON.parse(raw) as { stats_last_tick_at: string };
    expect(stored.stats_last_tick_at).toBe(tickedAt);
  });

  test("applies decay: 1hr elapsed reduces hunger", async () => {
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats: { hp: 10, hunger: 10, energy: 10, mood: 10, bond: 10 },
      stats_last_tick_at: "2026-05-18T09:00:00.000Z",
    };
    await writeProgression(tmp, prog);

    const now = new Date("2026-05-18T10:00:00.000Z");
    await pokeOnce({ homeBase: tmp, now: () => now });

    const raw = await readFile(join(tmp, "progression.json"), "utf8");
    const stored = JSON.parse(raw) as { stats: { hunger: number } };
    // 1hr at 0.5/hr = hunger should be 9.5
    expect(stored.stats.hunger).toBeCloseTo(9.5, 5);
  });

  test("multiple pokes with advancing clock do not double-apply decay", async () => {
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats: { hp: 10, hunger: 10, energy: 10, mood: 10, bond: 10 },
      stats_last_tick_at: "2026-05-18T08:00:00.000Z",
    };
    await writeProgression(tmp, prog);

    const t1 = new Date("2026-05-18T09:00:00.000Z"); // +1hr
    const t2 = new Date("2026-05-18T10:00:00.000Z"); // +1hr

    await pokeOnce({ homeBase: tmp, now: () => t1 });
    await pokeOnce({ homeBase: tmp, now: () => t2 });

    const raw = await readFile(join(tmp, "progression.json"), "utf8");
    const stored = JSON.parse(raw) as { stats: { hunger: number }; stats_last_tick_at: string };
    // Total: 2hrs at 0.5/hr = hunger 9.0 (10 - 0.5 - 0.5)
    expect(stored.stats.hunger).toBeCloseTo(9.0, 4);
    expect(stored.stats_last_tick_at).toBe(t2.toISOString());
  });

  test("same timestamp twice does not decay further", async () => {
    const prog = {
      ...DEFAULT_PROGRESSION,
      stats: { hp: 10, hunger: 10, energy: 10, mood: 10, bond: 10 },
      stats_last_tick_at: "2026-05-18T10:00:00.000Z",
    };
    await writeProgression(tmp, prog);

    const now = new Date("2026-05-18T10:00:00.000Z");
    await pokeOnce({ homeBase: tmp, now: () => now });
    await pokeOnce({ homeBase: tmp, now: () => now });

    const raw = await readFile(join(tmp, "progression.json"), "utf8");
    const stored = JSON.parse(raw) as { stats: { hunger: number } };
    expect(stored.stats.hunger).toBe(10); // no decay for 0hr elapsed
  });
});
