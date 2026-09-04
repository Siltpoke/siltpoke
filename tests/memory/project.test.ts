import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProjectRoot,
  emptyProject,
  readProject,
  writeProject,
  listActiveProjects,
  type ResolvedProject,
} from "../../src/memory/project";
import { projectMemorySchema, } from "../../src/memory/schema-v3";

let scratch: string;
let home: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "siltpoke-proj-"));
  home = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  test("falls back to cwd hash when neither marker nor git exists", () => {
    const r = resolveProjectRoot(scratch);
    expect(r.source).toBe("fallback");
    expect(r.project_root).toBe(scratch);
    expect(r.project_id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("uses git root when .git exists", () => {
    mkdirSync(join(scratch, ".git"));
    const r = resolveProjectRoot(scratch);
    expect(r.source).toBe("git");
    expect(r.project_root).toBe(scratch);
  });

  test("walks UP from a subdir to find .git", () => {
    mkdirSync(join(scratch, ".git"));
    const sub = join(scratch, "packages", "lib");
    mkdirSync(sub, { recursive: true });
    const r = resolveProjectRoot(sub);
    expect(r.source).toBe("git");
    expect(r.project_root).toBe(scratch);
  });

  test("marker takes precedence over git", () => {
    mkdirSync(join(scratch, ".git"));
    mkdirSync(join(scratch, ".siltpoke"));
    writeFileSync(
      join(scratch, ".siltpoke", "marker.json"),
      JSON.stringify({
        project_id: "deadbeefdeadbeef",
        project_root: scratch,
        display_name: "my-renamed-project",
        written_by: "siltpoke",
        written_at: "2026-05-16T00:00:00Z",
      }),
    );
    const r = resolveProjectRoot(scratch);
    expect(r.source).toBe("marker");
    expect(r.project_id).toBe("deadbeefdeadbeef");
    expect(r.display_name).toBe("my-renamed-project");
  });

  test("git project_id is deterministic for the same path", () => {
    mkdirSync(join(scratch, ".git"));
    const a = resolveProjectRoot(scratch);
    const b = resolveProjectRoot(scratch);
    expect(a.project_id).toBe(b.project_id);
  });

  test("different git roots produce different project_ids", () => {
    const a = mkdtempSync(join(tmpdir(), "siltpoke-proj-a-"));
    const b = mkdtempSync(join(tmpdir(), "siltpoke-proj-b-"));
    mkdirSync(join(a, ".git"));
    mkdirSync(join(b, ".git"));
    try {
      expect(resolveProjectRoot(a).project_id).not.toBe(
        resolveProjectRoot(b).project_id,
      );
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("malformed marker.json is ignored (falls through to git)", () => {
    mkdirSync(join(scratch, ".git"));
    mkdirSync(join(scratch, ".siltpoke"));
    writeFileSync(join(scratch, ".siltpoke", "marker.json"), "not json");
    const r = resolveProjectRoot(scratch);
    expect(r.source).toBe("git");
  });

  test("schema-invalid marker.json is ignored", () => {
    mkdirSync(join(scratch, ".git"));
    mkdirSync(join(scratch, ".siltpoke"));
    writeFileSync(
      join(scratch, ".siltpoke", "marker.json"),
      JSON.stringify({ project_id: "x" }),
    );
    const r = resolveProjectRoot(scratch);
    expect(r.source).toBe("git");
  });
});

describe("emptyProject", () => {
  test("returns a schema-valid baseline", () => {
    const resolved: ResolvedProject = {
      project_id: "abc123",
      project_root: scratch,
      display_name: "test",
      source: "git",
    };
    const p = emptyProject(resolved, new Date("2026-05-16T10:00:00Z"));
    expect(projectMemorySchema.safeParse(p).success).toBe(true);
    expect(p.schemaVersion).toBe(3);
    expect(p.project_id).toBe("abc123");
    expect(p.personality_drift.curiosity).toBe(0);
    expect(p.user_profile_override.communication_style).toBeNull();
  });
});

describe("readProject + writeProject", () => {
  test("returns null when file missing", async () => {
    expect(await readProject(home, "missing-id")).toBeNull();
  });

  test("round-trips a written project", async () => {
    const resolved: ResolvedProject = {
      project_id: "abc123",
      project_root: scratch,
      display_name: "test",
      source: "git",
    };
    const p = emptyProject(resolved);
    p.facts.push({
      id: "f-1",
      text: "user prefers terse",
      source_session_id: null,
      confidence: 0.9,
      status: "active",
      created_at: "2026-05-16T10:00:00Z",
      last_seen_at: "2026-05-16T10:00:00Z",
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
    });
    await writeProject(home, "abc123", p);
    const back = await readProject(home, "abc123");
    expect(back?.facts).toHaveLength(1);
    expect(back?.facts[0]?.text).toBe("user prefers terse");
  });

  test("writeProject creates projects/<id>/ dir", async () => {
    const resolved: ResolvedProject = {
      project_id: "xyz789",
      project_root: scratch,
      display_name: "test",
      source: "git",
    };
    await writeProject(home, "xyz789", emptyProject(resolved));
    expect(existsSync(join(home, "projects", "xyz789", "memory.json"))).toBe(true);
  });

  test("readProject quarantines malformed JSON", async () => {
    const dir = join(home, "projects", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.json"), "not json");
    const r = await readProject(home, "bad");
    expect(r).toBeNull();
    const found = readdirSync(dir).some((f) => f.includes("corrupt"));
    expect(found).toBe(true);
  });

  test("readProject quarantines schema-invalid JSON", async () => {
    const dir = join(home, "projects", "bad2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "memory.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    expect(await readProject(home, "bad2")).toBeNull();
  });

  test("[hardening][regression] readProject loads a legacy memory.json containing a learned_rule over 200 chars intact, without quarantining", async () => {
    // Same regression as memory.test.ts's readMemory version, for the v3
    // per-project store: a learned_rule persisted before the write-side
    // 200-char cap existed (Control 2, 2026-07-13) must not cause the whole
    // project memory.json to be quarantined on read.
    const resolved: ResolvedProject = {
      project_id: "legacy-id",
      project_root: scratch,
      display_name: "test",
      source: "git",
    };
    const p = emptyProject(resolved);
    const legacyRuleText = "z".repeat(250);
    p.learned_rules.push({
      id: "lr-legacy",
      rule: legacyRuleText,
      category: "null_check",
      created_at: "2026-01-01T00:00:00Z",
      applied_count: 1,
      effectiveness: "good",
    });
    const dir = join(home, "projects", "legacy-id");
    mkdirSync(dir, { recursive: true });
    // Bypass writeProject's own schema-safe construction — simulate raw
    // pre-existing data on disk exactly as an upgrading user would have it.
    writeFileSync(join(dir, "memory.json"), JSON.stringify(p, null, 2));

    const got = await readProject(home, "legacy-id");
    expect(got).not.toBeNull();
    expect(got!.learned_rules).toHaveLength(1);
    expect(got!.learned_rules[0]?.rule).toBe(legacyRuleText);
    const entries = readdirSync(dir);
    expect(entries.includes("memory.json")).toBe(true);
    expect(entries.some((e) => e.includes("corrupt"))).toBe(false);
  });
});

describe("listActiveProjects fact_count", () => {
  test("fact_count reflects the project's stored facts", async () => {
    const projectId = "aaaaaaaaaaaaaaaa";
    const resolved: ResolvedProject = {
      project_id: projectId,
      project_root: scratch,
      display_name: "test",
      source: "git",
    };
    const p = emptyProject(resolved);
    p.facts.push({
      id: "f1",
      text: "x",
      source_session_id: null,
      confidence: 0.9,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      last_seen_at: "2026-01-01T00:00:00Z",
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
    });
    await writeProject(home, projectId, p);
    const list = await listActiveProjects(home);
    const row = list.find((r) => r.project_id === projectId);
    expect(row?.fact_count).toBe(1);
  });
});
