import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPet } from "../../src/cli/pet";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-pet-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const noon = new Date("2026-05-14T12:00:00Z");

test("first pet awards 5 XP", async () => {
  const r = await runPet({ homeBase: tmp, now: () => noon });
  expect(r.awarded).toBe(5);
  expect(r.capped).toBe(false);
  expect(r.xp).toBe(5);
});

test("pet has no per-action count cap (shared XP cap)", async () => {
  // 21 pets in one day used to trip the legacy 2/day pet cap. Now the only
  // cap is shared ACTION_XP_DAILY_CAP=100 (>= 20 pets at 5 XP each).
  for (let i = 0; i < 19; i++) {
    const r = await runPet({ homeBase: tmp, now: () => noon });
    expect(r.capped).toBe(false);
    expect(r.awarded).toBe(5);
  }
  // 20th pet: 95 XP awarded so far, this one grants 5 → exactly hits the
  // 100 XP cap. Also crosses xp_to_next_level=100 → level up to 2, xp resets.
  const r20 = await runPet({ homeBase: tmp, now: () => noon });
  expect(r20.capped).toBe(false);
  expect(r20.awarded).toBe(5);
  expect(r20.level).toBe(2);
  expect(r20.xp).toBe(0);
  // 21st pet: budget exhausted → awarded=0, capped=true, but stats still apply.
  const r21 = await runPet({ homeBase: tmp, now: () => noon });
  expect(r21.capped).toBe(true);
  expect(r21.awarded).toBe(0);
  expect(r21.level).toBe(2);
});

test("pet writes state.json mood=happy with bubble", async () => {
  const r = await runPet({ homeBase: tmp, now: () => noon });
  const state = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8"));
  expect(state.mood).toBe("happy");
  expect(state.bubble_short).toBe(r.bubble);
});

test("XP-capped pet still writes state.json (stats applied even when capped)", async () => {
  // Exhaust the daily XP budget first.
  for (let i = 0; i < 20; i++) {
    await runPet({ homeBase: tmp, now: () => noon });
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(tmp, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "watching",
      pose: "base",
      bubble_short: "stay",
      severity: "info",
      confidence: "high",
      last_updated_ms: 1,
      last_session_id: "x",
    }),
  );
  const r = await runPet({ homeBase: tmp, now: () => noon });
  expect(r.capped).toBe(true);
  const after = JSON.parse(readFileSync(join(tmp, "state.json"), "utf8"));
  // capped = XP cap reached, but the stat-effect path ran, so the
  // bubble + mood get refreshed. Old behavior (preserve prior state) is gone.
  expect(after.mood).toBe("happy");
});
