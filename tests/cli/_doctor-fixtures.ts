/**
 * Shared fixture helpers for doctor.test.ts + doctor.checks.test.ts.
 * Each test calls `setupDoctorTmp()` in `beforeEach` and `teardownDoctorTmp(env)`
 * in `afterEach`.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DoctorTmp {
  tmp: string;
  claudeHome: string;
  siltpokeHome: string;
}

export function setupDoctorTmp(label = "siltpoke-doctor-"): DoctorTmp {
  const tmp = mkdtempSync(join(tmpdir(), label));
  const claudeHome = join(tmp, ".claude");
  const siltpokeHome = join(tmp, ".siltpoke");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(siltpokeHome, { recursive: true });
  return { tmp, claudeHome, siltpokeHome };
}

export function teardownDoctorTmp(env: DoctorTmp): void {
  rmSync(env.tmp, { recursive: true, force: true });
}

export function validGlobalV3(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    name: "siltpoke",
    species: "cat",
    appearance: { head: "cat", face: "neutral", legs: "default" },
    level: 1,
    xp_total: 0,
    xp_log: [],
    achievements_unlocked: [],
    streak: { current_days: 0, longest_days: 0, last_qualifying_local_date: null },
    bond_meter: 0,
    daily_caps_state: { local_date: "2026-05-26", per_source_counts: {} },
    personality_base: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0, curiosity: 0 },
    user_profile: { name: "", communication_style: "neutral" },
  };
}
