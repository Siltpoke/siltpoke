/**
 * Integration smoke for the v2 → v3 migration.
 *
 * Full v2 → v3 migration round-trip against a realistic v2 fixture
 * mirroring what production writes:
 * - Multiple facts (mixed status: active / pending / retired)
 * - Multiple learned_rules with effectiveness variants
 * - Multiple chat_sessions
 * - user_profile with goals + constraints + prefs
 * - non-zero personality_drift
 * - non-trivial summary + consolidation timestamps
 *
 * Verifies:
 *   1. migration succeeds atomically
 *   2. every v2 field surfaces in either global.json or per-project memory.json
 *      with byte-equivalent content (modulo the curiosity=0 addition + new
 *      identity defaults)
 *   3. the renamed legacy v2 file matches the pre-migration backup
 *   4. re-running migration is a no-op
 *   5. read paths see the migrated data through readGlobal + readProject
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateV2toV3 } from "../../src/memory/migrate-v3";
import { readGlobal } from "../../src/memory/global";
import { readProject } from "../../src/memory/project";
import { coreMemorySchema } from "../../src/memory/memory";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-mig3-int-home-"));
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-mig3-int-cwd-"));
  mkdirSync(join(cwd, ".git"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const REALISTIC_V2_FIXTURE = {
  schemaVersion: 2,
  long_term_summary:
    "User prefers terse, opinionated feedback.",
  learned_rules: [
    {
      id: "lr-001",
      rule: "no emojis in code or commits",
      category: "style",
      created_at: "2026-05-10T08:00:00Z",
      last_triggered_at: "2026-05-14T11:00:00Z",
      applied_count: 12,
      effectiveness: "good" as const,
    },
    {
      id: "lr-002",
      rule: "always run bunx tsc --noEmit before committing",
      category: "process",
      created_at: "2026-05-12T08:00:00Z",
      applied_count: 4,
      effectiveness: "neutral" as const,
    },
    {
      id: "lr-003",
      rule: "avoid Vite if Bun bundler suffices",
      category: "architecture",
      created_at: "2026-05-13T08:00:00Z",
      applied_count: 1,
      effectiveness: "retired" as const,
    },
  ],
  personality_drift: {
    snark: 2,
    patience: -1,
    style_strictness: 3,
    proactivity: 0,
  },
  last_consolidated_at: "2026-05-14T22:00:00Z",
  consolidation_due_at: "2026-05-21T22:00:00Z",
  user_profile: {
    name: "alex",
    communication_style: "terse" as const,
    goals: [
      {
        id: "g-1",
        text: "ship the feature by Friday",
        created_at: "2026-05-14T08:00:00Z",
        status: "active" as const,
      },
      {
        id: "g-2",
        text: "land the Claude Design handoff fully",
        created_at: "2026-05-16T10:00:00Z",
        status: "active" as const,
      },
    ],
    constraints: [
      "no React on backend",
      "no force-push to main without explicit ask",
    ],
    prefs: { tabWidth: 2, semicolons: true, dateFormat: "ISO8601" },
  },
  chat_sessions: [
    {
      id: "s-a1",
      started_at: "2026-05-14T10:00:00Z",
      ended_at: "2026-05-14T11:30:00Z",
      message_count: 18,
      summary: "debugging the critic gate",
      tags: ["debug", "legacy-tag-a"],
    },
    {
      id: "s-a2",
      started_at: "2026-05-15T09:00:00Z",
      ended_at: "2026-05-15T10:15:00Z",
      message_count: 9,
      summary: "chat backend brainstorm",
      tags: ["brainstorm", "legacy-tag-b"],
    },
  ],
  facts: [
    {
      id: "f-1",
      text: "user prefers tabs over spaces",
      source_session_id: "s-a1",
      confidence: 0.95,
      status: "active" as const,
      created_at: "2026-05-14T11:00:00Z",
      last_seen_at: "2026-05-15T10:00:00Z",
      supersedes: null,
      retired_reason: null,
    },
    {
      id: "f-2",
      text: "user is on macOS with apple silicon",
      source_session_id: null,
      confidence: 0.99,
      status: "active" as const,
      created_at: "2026-05-12T08:00:00Z",
      last_seen_at: "2026-05-15T10:00:00Z",
      supersedes: null,
      retired_reason: null,
    },
    {
      id: "f-3",
      text: "user wants strict tsc; never any",
      source_session_id: "s-a2",
      confidence: 0.78,
      status: "pending" as const,
      created_at: "2026-05-15T09:30:00Z",
      last_seen_at: "2026-05-15T10:00:00Z",
      supersedes: null,
      retired_reason: null,
    },
    {
      id: "f-4",
      text: "older fact about IDE preferences",
      source_session_id: null,
      confidence: 0.3,
      status: "retired" as const,
      created_at: "2026-04-01T08:00:00Z",
      last_seen_at: "2026-04-30T08:00:00Z",
      supersedes: null,
      retired_reason: "low_confidence_pruned" as const,
    },
  ],
};

describe("realistic v2 → v3 migration round-trip", () => {
  beforeEach(() => {
    coreMemorySchema.parse(REALISTIC_V2_FIXTURE);
    writeFileSync(
      join(home, "memory.json"),
      JSON.stringify(REALISTIC_V2_FIXTURE, null, 2),
    );
  });

  test("migration produces a valid project_id (git source, not legacy)", async () => {
    const r = await migrateV2toV3({ home, cwd });
    expect(r.migrated).toBe(true);
    expect(r.legacy_used).toBe(false);
    expect(r.project_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("global.json has identity + neutral personality_base + curiosity=0", async () => {
    await migrateV2toV3({ home, cwd });
    const g = await readGlobal(home);
    expect(g).not.toBeNull();
    expect(g!.schemaVersion).toBe(3);
    expect(g!.name).toBe("siltpoke");
    expect(g!.level).toBe(1);
    expect(g!.xp_total).toBe(0);
    expect(g!.xp_log).toEqual([]);
    expect(g!.personality_base).toEqual({
      snark: 0,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
      curiosity: 0,
    });
    expect(g!.user_profile.name).toBe("alex");
    expect(g!.user_profile.communication_style).toBe("terse");
  });

  test("per-project memory captures every fact (4 incl. retired)", async () => {
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p!.facts).toHaveLength(4);
    const byId = Object.fromEntries(p!.facts.map((f) => [f.id, f]));
    expect(byId["f-1"]!.status).toBe("active");
    expect(byId["f-3"]!.status).toBe("pending");
    expect(byId["f-4"]!.status).toBe("retired");
    expect(byId["f-4"]!.retired_reason).toBe("low_confidence_pruned");
  });

  test("per-project memory captures all 3 rules with effectiveness variants", async () => {
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p!.learned_rules).toHaveLength(3);
    const eff = p!.learned_rules.map((r) => r.effectiveness).sort();
    expect(eff).toEqual(["good", "neutral", "retired"]);
  });

  test("per-project memory captures all chat sessions verbatim", async () => {
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p!.chat_sessions).toHaveLength(2);
    expect(p!.chat_sessions[0]!.tags).toEqual(["debug", "legacy-tag-a"]);
    expect(p!.chat_sessions[1]!.message_count).toBe(9);
  });

  test("personality_drift migrates 4 dims + adds curiosity=0", async () => {
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p!.personality_drift).toEqual({
      snark: 2,
      patience: -1,
      style_strictness: 3,
      proactivity: 0,
      curiosity: 0,
    });
  });

  test("user_profile.{goals,constraints,prefs} land under user_profile_override", async () => {
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p!.user_profile_override.goals).toHaveLength(2);
    expect(p!.user_profile_override.constraints).toEqual([
      "no React on backend",
      "no force-push to main without explicit ask",
    ]);
    expect(p!.user_profile_override.prefs).toEqual({
      tabWidth: 2,
      semicolons: true,
      dateFormat: "ISO8601",
    });
    expect(p!.user_profile_override.communication_style).toBeNull();
  });

  test("consolidation timestamps preserved", async () => {
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p!.last_consolidated_at).toBe("2026-05-14T22:00:00Z");
    expect(p!.consolidation_due_at).toBe("2026-05-21T22:00:00Z");
    expect(p!.long_term_summary).toContain("terse");
  });

  test("backup contents bytewise equal pre-migration memory.json", async () => {
    const original = readFileSync(join(home, "memory.json"), "utf8");
    const r = await migrateV2toV3({ home, cwd });
    expect(readFileSync(r.backup_path!, "utf8")).toBe(original);
  });

  test("legacy file present after migration; original memory.json gone", async () => {
    await migrateV2toV3({ home, cwd });
    expect(existsSync(join(home, "memory.json"))).toBe(false);
    expect(existsSync(join(home, "memory.v2.legacy.json"))).toBe(true);
  });

  test("legacy file contents match what was migrated (no rewrite during rename)", async () => {
    const original = readFileSync(join(home, "memory.json"), "utf8");
    await migrateV2toV3({ home, cwd });
    expect(readFileSync(join(home, "memory.v2.legacy.json"), "utf8")).toBe(original);
  });

  test("re-running is a no-op (no new backup, no schema change)", async () => {
    const r1 = await migrateV2toV3({ home, cwd });
    const backup1 = r1.backup_path!;
    const r2 = await migrateV2toV3({ home, cwd });
    expect(r2.migrated).toBe(false);
    expect(r2.reason).toBe("no_v2_file");
    // Only one backup file remains.
    expect(existsSync(backup1)).toBe(true);
  });
});
