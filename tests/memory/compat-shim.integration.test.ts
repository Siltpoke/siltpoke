/**
 * Integration smoke for the compat-shim auto-migration.
 *
 * Seeds a realistic v2 memory.json, runs migrateV2toV3 (simulating install
 * auto-fire), then exercises pre-split callers through the v3-aware shim:
 * appendLearnedRule + facts mutation + write/read round-trip. All callers
 * must continue working unchanged.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd as getCwd } from "node:process";
import {
  readMemory,
  writeMemory,
  appendLearnedRule,
  type CoreMemory,
} from "../../src/memory/memory";
import { migrateV2toV3 } from "../../src/memory/migrate-v3";
import { coreMemorySchema } from "../../src/memory/memory";
import { readProject, resolveProjectRoot } from "../../src/memory/project";

let home: string;
let projectCwdSrc: string;
let projectCwd: string;
let prevCwd: string;

const v2Fixture = {
  schemaVersion: 2,
  long_term_summary: "user prefers terse feedback",
  learned_rules: [
    {
      id: "lr-existing",
      rule: "always run tsc before commit",
      category: "process",
      created_at: "2026-05-14T08:00:00Z",
      applied_count: 5,
      effectiveness: "good" as const,
    },
  ],
  personality_drift: {
    snark: 2,
    patience: -1,
    style_strictness: 1,
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
        text: "ship the feature",
        created_at: "2026-05-14T08:00:00Z",
        status: "active" as const,
      },
    ],
    constraints: ["no React on backend"],
    prefs: { tabWidth: 2 },
  },
  chat_sessions: [
    {
      id: "s-1",
      started_at: "2026-05-14T10:00:00Z",
      ended_at: "2026-05-14T11:30:00Z",
      message_count: 18,
      summary: "debug",
      tags: ["debug"],
    },
  ],
  facts: [
    {
      id: "f-existing",
      text: "user prefers tabs",
      source_session_id: "s-1",
      confidence: 0.95,
      status: "active" as const,
      created_at: "2026-05-14T11:00:00Z",
      last_seen_at: "2026-05-15T10:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
    },
  ],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-shim-int-home-"));
  projectCwdSrc = mkdtempSync(join(tmpdir(), "siltpoke-shim-int-cwd-"));
  mkdirSync(join(projectCwdSrc, ".git"));
  prevCwd = getCwd();
  chdir(projectCwdSrc);
  projectCwd = getCwd();
  coreMemorySchema.parse(v2Fixture);
  writeFileSync(join(home, "memory.json"), JSON.stringify(v2Fixture));
});

afterEach(() => {
  chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  rmSync(projectCwdSrc, { recursive: true, force: true });
});

describe("auto-migration + shim end-to-end", () => {
  test("readMemory pre-migration still returns the v2 file (back-compat)", async () => {
    const m = await readMemory(home);
    expect(m?.facts).toHaveLength(1);
    expect(m?.facts[0]?.id).toBe("f-existing");
    expect(m?.user_profile.name).toBe("alex");
  });

  test("post-migration readMemory returns the same v2 shape via shim", async () => {
    await migrateV2toV3({ home, cwd: projectCwd });
    expect(existsSync(join(home, "global.json"))).toBe(true);

    const m = await readMemory(home);
    expect(m).not.toBeNull();
    expect(m?.schemaVersion).toBe(2);
    expect(m?.facts).toHaveLength(1);
    expect(m?.facts[0]?.id).toBe("f-existing");
    expect(m?.user_profile.name).toBe("alex");
    expect(m?.user_profile.communication_style).toBe("terse");
    expect(m?.user_profile.goals).toHaveLength(1);
    expect(m?.user_profile.constraints).toEqual(["no React on backend"]);
    expect(m?.user_profile.prefs).toEqual({ tabWidth: 2 });
    expect(m?.long_term_summary).toContain("terse");
    expect(m?.personality_drift.snark).toBe(2);
    expect(m?.chat_sessions).toHaveLength(1);
    expect(m?.learned_rules).toHaveLength(1);
  });

  test("post-migration appendLearnedRule writes through the shim", async () => {
    await migrateV2toV3({ home, cwd: projectCwd });
    const r = await appendLearnedRule(home, {
      id: "lr-new",
      // Realistic imperative rule (passes the write-time garbage filter — has
      // an action verb + >= 4 words). Content is incidental here; this test
      // exercises shim write-through, not garbage filtering.
      rule: "Avoid emojis in commit messages entirely.",
      category: "style",
      created_at: "2026-05-16T00:00:00Z",
      applied_count: 0,
      effectiveness: "neutral",
    });
    expect(r.appended).toBe(true);

    const m = await readMemory(home);
    expect(m?.learned_rules).toHaveLength(2);
    expect(m?.learned_rules.find((r) => r.id === "lr-new")).toBeDefined();
    expect(m?.learned_rules.find((r) => r.id === "lr-existing")).toBeDefined();

    // Verify it actually went into the per-project store
    const resolved = resolveProjectRoot(projectCwd);
    const p = await readProject(home, resolved.project_id);
    expect(p?.learned_rules.find((r) => r.id === "lr-new")).toBeDefined();
  });

  test("post-migration writeMemory + read round-trip preserves all v2 fields", async () => {
    await migrateV2toV3({ home, cwd: projectCwd });

    // Mutate the merged memory and write it back through the shim.
    const m1 = (await readMemory(home))!;
    const m2: CoreMemory = {
      ...m1,
      long_term_summary: `${m1.long_term_summary} (updated)`,
      facts: [
        ...m1.facts,
        {
          id: "f-new",
          text: "added via shim",
          source_session_id: null,
          confidence: 0.8,
          status: "pending",
          created_at: "2026-05-16T00:00:00Z",
          last_seen_at: "2026-05-16T00:00:00Z",
          supersedes: null,
          superseded_by: null,
          pinned: false,
          recall_count: 0,
          retired_reason: null,
          stability: "durable",
          learned_from: null,
          last_confirmed_at: null,
          expires_at: null,
        save_reason: null,
        invalid_at: null,
        events: [],
        },
      ],
      user_profile: {
        ...m1.user_profile,
        constraints: [...m1.user_profile.constraints, "no @ts-ignore"],
      },
    };
    await writeMemory(home, m2);

    const m3 = (await readMemory(home))!;
    expect(m3.long_term_summary).toContain("(updated)");
    expect(m3.facts).toHaveLength(2);
    expect(m3.facts.find((f) => f.id === "f-new")).toBeDefined();
    expect(m3.user_profile.constraints).toContain("no @ts-ignore");
    expect(m3.user_profile.name).toBe("alex");
  });

  test("post-migration writes go to v3 files; no new v2 memory.json appears", async () => {
    await migrateV2toV3({ home, cwd: projectCwd });
    const m = (await readMemory(home))!;
    await writeMemory(home, m);
    expect(existsSync(join(home, "memory.json"))).toBe(false);
    expect(existsSync(join(home, "memory.v2.legacy.json"))).toBe(true);
    expect(existsSync(join(home, "global.json"))).toBe(true);
  });

  test("v3-only project fields survive after a v2-shape write", async () => {
    const migrationResult = await migrateV2toV3({ home, cwd: projectCwd });
    const projectId = migrationResult.project_id!;

    // Stamp a v3-only project field outside of the shim.
    const { writeProject, readProject } = await import("../../src/memory/project");
    const p0 = (await readProject(home, projectId))!;
    p0.personality_drift.curiosity = 3;
    await writeProject(home, projectId, p0);

    // Now write via the shim (4-dim drift only).
    const m = (await readMemory(home))!;
    m.personality_drift.snark = 3;
    await writeMemory(home, m);

    // Curiosity should still be 3.
    const p1 = (await readProject(home, projectId))!;
    expect(p1.personality_drift.curiosity).toBe(3);
    expect(p1.personality_drift.snark).toBe(3);
  });
});
