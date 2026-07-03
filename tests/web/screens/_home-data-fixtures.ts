/**
 * Shared fixture writer for Home.data.* test files.
 *
 * Writes config.json + progression.json + memory.json to `tmp` matching the
 * siltpoke basePath layout (memory.json + progression.json sit directly in
 * basePath, not under .siltpoke/).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const HOME_DATA_NOW = new Date("2026-05-18T14:00:00Z");

export function writeHomeFixtures(
  tmp: string,
  opts: {
    config?: Record<string, unknown>;
    progression?: Record<string, unknown>;
    memory?: Record<string, unknown>;
  },
): void {
  const config = opts.config ?? { name: "Bangbang", species: "cat" };
  const progression = opts.progression ?? {
    schemaVersion: 1,
    level: 3,
    xp: 240,
    xp_to_next_level: 500,
    unlocked_poses: ["base", "peek"],
    unlocked_titles: ["Hatchling", "Watcher"],
    pet_log: [
      { day: "2026-05-16", count: 2 },
      { day: "2026-05-17", count: 1 },
      { day: "2026-05-18", count: 1 },
    ],
    daily_actions: [
      { day: "2026-05-17", feed: 1, play: 1, pet: 1, tease: 0 },
      { day: "2026-05-18", feed: 1, play: 0, pet: 1, tease: 0 },
    ],
  };
  const memory = opts.memory ?? {
    schemaVersion: 2,
    long_term_summary: "Test user.",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: "2026-05-18T00:00:00Z",
    consolidation_due_at: "2026-05-25T00:00:00Z",
    user_profile: {
      communication_style: "neutral",
      goals: [],
      constraints: [],
      prefs: {},
    },
    chat_sessions: [],
    facts: [
      {
        id: "fact-001",
        text: "User prefers TypeScript.",
        source_session_id: null,
        confidence: 0.95,
        status: "active",
        created_at: "2026-05-18T10:00:00Z",
        last_seen_at: "2026-05-18T10:00:00Z",
        supersedes: null,
        retired_reason: null,
      },
      {
        id: "fact-002",
        text: "User uses bun as runtime.",
        source_session_id: null,
        confidence: 0.9,
        status: "active",
        created_at: "2026-05-17T08:00:00Z",
        last_seen_at: "2026-05-17T08:00:00Z",
        supersedes: null,
        retired_reason: null,
      },
    ],
  };

  writeFileSync(join(tmp, "config.json"), JSON.stringify(config), "utf8");
  writeFileSync(join(tmp, "progression.json"), JSON.stringify(progression), "utf8");
  writeFileSync(join(tmp, "memory.json"), JSON.stringify(memory), "utf8");
}
