import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateV2toV3 } from "../../src/memory/migrate-v3";
import { readGlobal } from "../../src/memory/global";
import { readProject, resolveProjectRoot } from "../../src/memory/project";
import { coreMemorySchema } from "../../src/memory/memory";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-mig3-home-"));
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-mig3-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function seedV2(home: string): void {
  const v2 = {
    schemaVersion: 2,
    long_term_summary: "user likes terse feedback",
    learned_rules: [
      {
        id: "lr-1",
        rule: "no emojis",
        category: "style",
        created_at: "2026-05-14T00:00:00Z",
        applied_count: 3,
        effectiveness: "good",
      },
    ],
    personality_drift: {
      snark: 1,
      patience: -1,
      style_strictness: 2,
      proactivity: 0,
    },
    last_consolidated_at: "2026-05-14T00:00:00Z",
    consolidation_due_at: "2026-05-21T00:00:00Z",
    user_profile: {
      name: "alex",
      communication_style: "terse",
      goals: [
        { id: "g-1", text: "ship the feature", created_at: "2026-05-14T00:00:00Z", status: "active" },
      ],
      constraints: ["no React on backend"],
      prefs: { tabWidth: 2 },
    },
    chat_sessions: [
      {
        id: "s-1",
        started_at: "2026-05-14T10:00:00Z",
        ended_at: "2026-05-14T11:00:00Z",
        message_count: 4,
        summary: "debugging",
        tags: ["debug"],
      },
    ],
    facts: [
      {
        id: "f-1",
        text: "user prefers tabs",
        source_session_id: null,
        confidence: 0.9,
        status: "active",
        created_at: "2026-05-14T00:00:00Z",
        last_seen_at: "2026-05-14T00:00:00Z",
        supersedes: null,
        retired_reason: null,
      },
    ],
  };
  // Sanity-check against the v2 schema before writing.
  coreMemorySchema.parse(v2);
  writeFileSync(join(home, "memory.json"), JSON.stringify(v2));
}

describe("migrateV2toV3", () => {
  test("no-op when no v2 file present", async () => {
    const r = await migrateV2toV3({ home, cwd });
    expect(r.migrated).toBe(false);
    expect(r.reason).toBe("no_v2_file");
  });

  test("idempotent: re-run after successful migration is a no-op", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const a = await migrateV2toV3({ home, cwd });
    expect(a.migrated).toBe(true);
    const b = await migrateV2toV3({ home, cwd });
    expect(b.migrated).toBe(false);
    expect(b.reason).toBe("no_v2_file");
  });

  test("creates backup before splitting", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const r = await migrateV2toV3({ home, cwd });
    expect(r.migrated).toBe(true);
    expect(r.backup_path).toBeDefined();
    expect(existsSync(r.backup_path!)).toBe(true);
  });

  test("renames legacy memory.json after success", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    await migrateV2toV3({ home, cwd });
    expect(existsSync(join(home, "memory.json"))).toBe(false);
    expect(existsSync(join(home, "memory.v2.legacy.json"))).toBe(true);
  });

  test("global.json contains identity fields from user_profile", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    await migrateV2toV3({ home, cwd });
    const g = await readGlobal(home);
    expect(g?.schemaVersion).toBe(3);
    expect(g?.user_profile.name).toBe("alex");
    expect(g?.user_profile.communication_style).toBe("terse");
    expect(g?.personality_base.curiosity).toBe(0);
  });

  test("per-project memory.json contains facts/chats/rules/drift/goals", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const r = await migrateV2toV3({ home, cwd });
    expect(r.legacy_used).toBe(false);
    const p = await readProject(home, r.project_id!);
    expect(p?.schemaVersion).toBe(3);
    expect(p?.facts).toHaveLength(1);
    expect(p?.facts[0]?.text).toBe("user prefers tabs");
    expect(p?.chat_sessions).toHaveLength(1);
    expect(p?.learned_rules).toHaveLength(1);
    expect(p?.personality_drift).toEqual({
      snark: 1,
      patience: -1,
      style_strictness: 2,
      proactivity: 0,
      curiosity: 0,
    });
    expect(p?.user_profile_override.goals).toHaveLength(1);
    expect(p?.user_profile_override.constraints).toEqual(["no React on backend"]);
    expect(p?.user_profile_override.prefs).toEqual({ tabWidth: 2 });
  });

  test("uses __legacy__ sentinel when cwd doesn't resolve to a project", async () => {
    seedV2(home);
    // cwd has no .git, no marker → fallback resolution → migration uses __legacy__
    const r = await migrateV2toV3({ home, cwd });
    expect(r.migrated).toBe(true);
    expect(r.legacy_used).toBe(true);
    expect(r.project_id).toBe("__legacy__");
    const p = await readProject(home, "__legacy__");
    expect(p).not.toBeNull();
    expect(p?.facts).toHaveLength(1);
  });

  test("forceLegacy option lands content under __legacy__ regardless of cwd", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const r = await migrateV2toV3({ home, cwd, forceLegacy: true });
    expect(r.project_id).toBe("__legacy__");
    expect(r.legacy_used).toBe(true);
  });

  test("uses real project_id when cwd is a git repo", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const r = await migrateV2toV3({ home, cwd });
    const resolved = resolveProjectRoot(cwd);
    expect(r.project_id).toBe(resolved.project_id);
    expect(r.legacy_used).toBe(false);
  });

  test("preserves last_consolidated_at + consolidation_due_at on the per-project file", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const r = await migrateV2toV3({ home, cwd });
    const p = await readProject(home, r.project_id!);
    expect(p?.last_consolidated_at).toBe("2026-05-14T00:00:00Z");
    expect(p?.consolidation_due_at).toBe("2026-05-21T00:00:00Z");
  });

  test("malformed v2 memory.json is treated as no_v2_file", async () => {
    writeFileSync(join(home, "memory.json"), "not json");
    const r = await migrateV2toV3({ home, cwd });
    expect(r.migrated).toBe(false);
  });

  test("schema-invalid v2 memory.json is treated as no_v2_file", async () => {
    writeFileSync(join(home, "memory.json"), JSON.stringify({ schemaVersion: 99 }));
    const r = await migrateV2toV3({ home, cwd });
    expect(r.migrated).toBe(false);
  });

  test("backup is created under backups/ subdir", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const r = await migrateV2toV3({ home, cwd });
    const backupsDir = join(home, "backups");
    expect(existsSync(backupsDir)).toBe(true);
    const files = readdirSync(backupsDir);
    expect(files.some((f) => f.startsWith("memory.v2."))).toBe(true);
    expect(r.backup_path).toContain("memory.v2.");
  });

  test("backup contents equal the original v2 file (no data loss)", async () => {
    seedV2(home);
    mkdirSync(join(cwd, ".git"));
    const original = readFileSync(join(home, "memory.json"), "utf8");
    const r = await migrateV2toV3({ home, cwd });
    const backup = readFileSync(r.backup_path!, "utf8");
    expect(backup).toBe(original);
  });
});
