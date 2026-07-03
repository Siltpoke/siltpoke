/**
 * Tests for vitalsWriter.ts — maybeWriteSnapshot
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeWriteSnapshot } from "../../src/state/vitalsWriter";
import { DEFAULT_PROGRESSION } from "../../src/state/progression";
import type { Progression } from "../../src/state/progression";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-vitals-writer-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readSnapshots(basePath: string): Record<string, unknown>[] {
  const path = join(basePath, "vitals.jsonl");
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function makeProgression(overrides: Partial<Progression> = {}): Progression {
  return {
    ...DEFAULT_PROGRESSION,
    stats: { hp: 10, hunger: 5, energy: 8, mood: 6, bond: 0 },
    ...overrides,
  };
}

describe("maybeWriteSnapshot", () => {
  test("no action yesterday → only today snapshot written", async () => {
    const now = new Date("2026-05-18T10:00:00Z");
    const prog = makeProgression({
      daily_actions: [
        { day: "2026-05-18", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
      ],
    });
    await maybeWriteSnapshot(prog, now, tmp);
    const snaps = readSnapshots(tmp);
    expect(snaps).toHaveLength(1);
    expect((snaps[0] as { day: string }).day).toBe("2026-05-18");
  });

  test("no actions at all → today still snapshotted (live sparkline)", async () => {
    const now = new Date("2026-05-18T10:00:00Z");
    const prog = makeProgression({ daily_actions: [] });
    await maybeWriteSnapshot(prog, now, tmp);
    const snaps = readSnapshots(tmp);
    expect(snaps).toHaveLength(1);
    expect((snaps[0] as { day: string }).day).toBe("2026-05-18");
  });

  test("action yesterday + action today → both days snapshotted", async () => {
    const now = new Date("2026-05-18T10:00:00Z");
    const prog = makeProgression({
      daily_actions: [
        { day: "2026-05-17", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
        { day: "2026-05-18", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
      ],
    });
    await maybeWriteSnapshot(prog, now, tmp);
    const snaps = readSnapshots(tmp);
    expect(snaps).toHaveLength(2);
    expect((snaps[0] as { day: string }).day).toBe("2026-05-17");
    expect((snaps[1] as { day: string }).day).toBe("2026-05-18");
  });

  test("yesterday snapshot xp_awarded priced from ACTION_BASE_XP (single table)", async () => {
    const now = new Date("2026-05-18T10:00:00Z");
    const prog = makeProgression({
      daily_actions: [
        // 2 feeds (2*5=10) + 1 play (3) + 1 tease (0) = 13 xp
        { day: "2026-05-17", feed: 2, play: 1, pet: 0, tease: 1, clean: 0, sleep: 0 },
        { day: "2026-05-18", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
      ],
    });
    await maybeWriteSnapshot(prog, now, tmp);
    const snaps = readSnapshots(tmp);
    // Find yesterday's entry (sorted ascending; first is 2026-05-17).
    expect((snaps[0] as { xp_awarded: number }).xp_awarded).toBe(13);
  });

  test("calling twice on same day overwrites today; yesterday stays one entry", async () => {
    const now = new Date("2026-05-18T10:00:00Z");
    const prog = makeProgression({
      daily_actions: [
        { day: "2026-05-17", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
        { day: "2026-05-18", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
      ],
    });
    await maybeWriteSnapshot(prog, now, tmp);
    await maybeWriteSnapshot(prog, now, tmp);
    const snaps = readSnapshots(tmp);
    expect(snaps).toHaveLength(2); // yesterday + today (today overwritten, not duplicated)
  });

  test("31 days of actions → file trimmed to 30 entries (most recent kept)", async () => {
    // Write snapshots for days 01 through 30 (30 entries already)
    const existingLines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const day = `2026-04-${i.toString().padStart(2, "0")}`;
      existingLines.push(
        JSON.stringify({ day, hp: 10, hunger: 5, energy: 8, mood: 6, bond: 0, xp_awarded: 0 }),
      );
    }
    writeFileSync(join(tmp, "vitals.jsonl"), `${existingLines.join("\n")}\n`, "utf8");

    // Trigger snapshot for 2026-05-02 (today) with action yesterday + today.
    // This adds 2026-05-01 (yesterday) + 2026-05-02 (today) → 32 total →
    // head-dropped to 30, so oldest two (04-01, 04-02) drop.
    const now = new Date("2026-05-02T10:00:00Z");
    const prog = makeProgression({
      daily_actions: [
        { day: "2026-05-01", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
        { day: "2026-05-02", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
      ],
    });
    await maybeWriteSnapshot(prog, now, tmp);

    const snaps = readSnapshots(tmp);
    expect(snaps).toHaveLength(30);
    // Newest entry should be today (2026-05-02).
    expect((snaps[29] as { day: string }).day).toBe("2026-05-02");
  });

  test("snapshot includes current stats values", async () => {
    const now = new Date("2026-05-18T10:00:00Z");
    const prog = makeProgression({
      stats: { hp: 7, hunger: 3, energy: 6, mood: 5, bond: 2 },
      daily_actions: [
        { day: "2026-05-17", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
        { day: "2026-05-18", feed: 1, play: 0, pet: 0, tease: 0, clean: 0, sleep: 0 },
      ],
    });
    await maybeWriteSnapshot(prog, now, tmp);
    const snaps = readSnapshots(tmp);
    // First entry = yesterday (oldest first).
    const snap = snaps[0] as { hp: number; hunger: number; energy: number; mood: number; bond: number };
    expect(snap.hp).toBe(7);
    expect(snap.hunger).toBe(3);
    expect(snap.energy).toBe(6);
    expect(snap.mood).toBe(5);
    expect(snap.bond).toBe(2);
  });
});
