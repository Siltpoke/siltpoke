/**
 * Tests for vitalsReader.ts — readVitalsSeries
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVitalsSeries } from "../../src/state/vitalsReader";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-vitals-reader-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeVitalsFile(basePath: string, lines: string[]): void {
  const content = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  writeFileSync(join(basePath, "vitals.jsonl"), content, "utf8");
}

function makeSnap(day: string, overrides: Partial<Record<string, number>> = {}): string {
  return JSON.stringify({
    day,
    hp:         overrides.hp     ?? 10,
    hunger:     overrides.hunger  ?? 5,
    energy:     overrides.energy  ?? 8,
    mood:       overrides.mood    ?? 6,
    bond:       overrides.bond    ?? 0,
    xp_awarded: overrides.xp_awarded ?? 0,
  });
}

describe("readVitalsSeries", () => {
  test("empty file → all-zero arrays of length 7", async () => {
    writeVitalsFile(tmp, []);
    const now = new Date("2026-05-18T12:00:00Z");
    const series = await readVitalsSeries(tmp, 7, now);
    expect(series.hp).toHaveLength(7);
    expect(series.hp.every((v) => v === 0)).toBe(true);
    expect(series.hunger.every((v) => v === 0)).toBe(true);
    expect(series.energy.every((v) => v === 0)).toBe(true);
    expect(series.mood.every((v) => v === 0)).toBe(true);
    expect(series.bond.every((v) => v === 0)).toBe(true);
    expect(series.xp_awarded.every((v) => v === 0)).toBe(true);
  });

  test("missing file → all-zero arrays of length 7", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const series = await readVitalsSeries(tmp, 7, now);
    expect(series.hp).toHaveLength(7);
    expect(series.hp.every((v) => v === 0)).toBe(true);
  });

  test("3 days of snapshots → leading zeros + 3 real values", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    // now = May 18 (today). Series covers May 12 - May 18 (last 7 inc. today).
    writeVitalsFile(tmp, [
      makeSnap("2026-05-16", { hunger: 3 }),
      makeSnap("2026-05-17", { hunger: 4 }),
      makeSnap("2026-05-18", { hunger: 5 }),
    ]);
    const series = await readVitalsSeries(tmp, 7, now);
    expect(series.hunger).toHaveLength(7);
    // Days: May 12=0, May 13=0, May 14=0, May 15=0, May 16=3, May 17=4, May 18=5
    expect(series.hunger).toEqual([0, 0, 0, 0, 3, 4, 5]);
  });

  test("10 days of snapshots → last 7 returned (oldest to newest)", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    // Series covers May 12 - May 18 (inclusive)
    const lines = [];
    for (let i = 9; i <= 18; i++) {
      lines.push(makeSnap(`2026-05-${i.toString().padStart(2, "0")}`, { hunger: i }));
    }
    writeVitalsFile(tmp, lines);
    const series = await readVitalsSeries(tmp, 7, now);
    expect(series.hunger).toHaveLength(7);
    // May 12=12 ... May 18=18
    expect(series.hunger).toEqual([12, 13, 14, 15, 16, 17, 18]);
  });

  test("stat values match file content", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    writeVitalsFile(tmp, [
      makeSnap("2026-05-18", { hp: 7, hunger: 3, energy: 6, mood: 5, bond: 2, xp_awarded: 10 }),
    ]);
    const series = await readVitalsSeries(tmp, 7, now);
    // May 18 (today) is index 6 (last day in the range).
    expect(series.hp[6]).toBe(7);
    expect(series.hunger[6]).toBe(3);
    expect(series.energy[6]).toBe(6);
    expect(series.mood[6]).toBe(5);
    expect(series.bond[6]).toBe(2);
    expect(series.xp_awarded[6]).toBe(10);
  });

  test("skips malformed JSONL lines", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    writeVitalsFile(tmp, [
      "not valid json",
      makeSnap("2026-05-18", { hunger: 9 }),
      "{ broken",
    ]);
    const series = await readVitalsSeries(tmp, 7, now);
    // Only the valid line (today) is read.
    expect(series.hunger[6]).toBe(9);
  });

  test("days parameter controls series length", async () => {
    const now = new Date("2026-05-18T12:00:00Z");
    const series = await readVitalsSeries(tmp, 3, now);
    expect(series.hp).toHaveLength(3);
    expect(series.hunger).toHaveLength(3);
  });
});
