import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateAll,
  MIGRATIONS,
  memoryV1toV2,
  type Migration,
} from "../../src/installer/migrations";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-mig-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("MIGRATIONS registry contains memoryV1toV2", () => {
  expect(MIGRATIONS).toContain(memoryV1toV2);
  expect(memoryV1toV2.file).toBe("memory");
  expect(memoryV1toV2.from).toBe(1);
  expect(memoryV1toV2.to).toBe(2);
});

test("migrateAll with empty (override) registry is a no-op", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ schemaVersion: 1, x: 1 }),
  );
  const r = await migrateAll(tmp, []);
  expect(r.migrated).toBe(0);
  expect(r.files_seen).toBe(1);
});

test("migrateAll applies a registered 1→2 migration", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ schemaVersion: 1, x: 1 }),
  );
  const reg: Migration[] = [
    {
      file: "config",
      from: 1,
      to: 2,
      migrate: (s) => ({ ...s, schemaVersion: 2, y: 99 }),
    },
  ];
  const r = await migrateAll(tmp, reg);
  expect(r.migrated).toBe(1);
  const after = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
  expect(after.schemaVersion).toBe(2);
  expect(after.y).toBe(99);
});

test("migrateAll chains 1→2→3 in one pass", async () => {
  writeFileSync(
    join(tmp, "memory.json"),
    JSON.stringify({ schemaVersion: 1 }),
  );
  const reg: Migration[] = [
    {
      file: "memory",
      from: 1,
      to: 2,
      migrate: (s) => ({ ...s, schemaVersion: 2, step1: true }),
    },
    {
      file: "memory",
      from: 2,
      to: 3,
      migrate: (s) => ({ ...s, schemaVersion: 3, step2: true }),
    },
  ];
  const r = await migrateAll(tmp, reg);
  expect(r.migrated).toBe(1);
  const after = JSON.parse(readFileSync(join(tmp, "memory.json"), "utf8"));
  expect(after.schemaVersion).toBe(3);
  expect(after.step1).toBe(true);
  expect(after.step2).toBe(true);
});

test("migrateAll skips files that don't exist", async () => {
  const reg: Migration[] = [
    {
      file: "config",
      from: 1,
      to: 2,
      migrate: (s) => ({ ...s, schemaVersion: 2 }),
    },
  ];
  const r = await migrateAll(tmp, reg);
  expect(r.files_seen).toBe(0);
  expect(r.migrated).toBe(0);
});

test("migrateAll records error on malformed non-memory JSON without quarantine", async () => {
  writeFileSync(join(tmp, "config.json"), "not json");
  const r = await migrateAll(tmp);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]?.file).toBe("config");
  // non-memory targets are NOT quarantined (low-value, regenerable)
  const entries = readdirSync(tmp);
  expect(entries.some((e) => e.includes(".corrupt-"))).toBe(false);
});

test("migrateAll quarantines malformed memory.json", async () => {
  writeFileSync(join(tmp, "memory.json"), "not json");
  const r = await migrateAll(tmp);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]?.file).toBe("memory");
  expect(r.errors[0]?.message).toContain("quarantined");
  const entries = readdirSync(tmp);
  const corrupt = entries.find((e) =>
    /^memory\.json\.corrupt-\d+$/.test(e),
  );
  expect(corrupt).toBeDefined();
  expect(entries.includes("memory.json")).toBe(false);
});

// --- v1→v2 memory migration ---

const v1MemorySample = {
  schemaVersion: 1,
  long_term_summary: "User likes Bun.",
  learned_rules: [
    {
      id: "lr-001",
      rule: "Always grep first.",
      category: "search_first",
      created_at: "2026-05-14T00:00:00Z",
      applied_count: 2,
      effectiveness: "good" as const,
    },
  ],
  personality_drift: {
    snark: 1,
    patience: -1,
    style_strictness: 0,
    proactivity: 2,
  },
  last_consolidated_at: "2026-05-14T00:00:00Z",
  consolidation_due_at: "2026-05-21T00:00:00Z",
};

test("memoryV1toV2 produces v2 shape with empty new fields", () => {
  const out = memoryV1toV2.migrate(v1MemorySample) as Record<string, unknown>;
  expect(out.schemaVersion).toBe(2);
  expect(out.user_profile).toEqual({
    communication_style: "neutral",
    goals: [],
    constraints: [],
    prefs: {},
  });
  expect(out.chat_sessions).toEqual([]);
  expect(out.facts).toEqual([]);
});

test("memoryV1toV2 preserves existing v1 fields verbatim", () => {
  const out = memoryV1toV2.migrate(v1MemorySample) as Record<string, unknown>;
  expect(out.long_term_summary).toBe("User likes Bun.");
  expect(out.learned_rules).toEqual(v1MemorySample.learned_rules);
  expect(out.personality_drift).toEqual(v1MemorySample.personality_drift);
  expect(out.last_consolidated_at).toBe("2026-05-14T00:00:00Z");
  expect(out.consolidation_due_at).toBe("2026-05-21T00:00:00Z");
});

test("migrateAll runs memoryV1toV2 on a v1 file", async () => {
  writeFileSync(
    join(tmp, "memory.json"),
    JSON.stringify(v1MemorySample),
  );
  const r = await migrateAll(tmp);
  expect(r.migrated).toBe(1);
  expect(r.errors).toEqual([]);
  const after = JSON.parse(readFileSync(join(tmp, "memory.json"), "utf8"));
  expect(after.schemaVersion).toBe(2);
  expect(after.user_profile.communication_style).toBe("neutral");
  expect(after.facts).toEqual([]);
  expect(after.chat_sessions).toEqual([]);
  expect(after.long_term_summary).toBe("User likes Bun.");
});

test("migrateAll is idempotent on already-v2 file", async () => {
  const v2Sample = memoryV1toV2.migrate(v1MemorySample);
  writeFileSync(join(tmp, "memory.json"), JSON.stringify(v2Sample));
  const r = await migrateAll(tmp);
  expect(r.migrated).toBe(0);
  expect(r.files_seen).toBe(1);
  const after = JSON.parse(readFileSync(join(tmp, "memory.json"), "utf8"));
  expect(after.schemaVersion).toBe(2);
});

test("memoryV1toV2 rejects non-v1 input via Zod parse", () => {
  expect(() =>
    memoryV1toV2.migrate({ schemaVersion: 99, foo: "bar" }),
  ).toThrow();
});

// --- backup tests ---

test("migrateAll writes .bak.v1.<ts> before overwriting v1", async () => {
  writeFileSync(join(tmp, "memory.json"), JSON.stringify(v1MemorySample));
  await migrateAll(tmp);
  const entries = readdirSync(tmp);
  const bak = entries.find((e) => /^memory\.json\.bak\.v1\.\d+$/.test(e));
  expect(bak).toBeDefined();
  const bakContents = JSON.parse(readFileSync(join(tmp, bak!), "utf8"));
  expect(bakContents.schemaVersion).toBe(1);
  expect(bakContents.long_term_summary).toBe("User likes Bun.");
});

test("migrateAll on already-v2 file does NOT create a bak (chain empty)", async () => {
  const v2Sample = memoryV1toV2.migrate(v1MemorySample);
  writeFileSync(join(tmp, "memory.json"), JSON.stringify(v2Sample));
  await migrateAll(tmp);
  const baks = readdirSync(tmp).filter((e) => e.includes(".bak."));
  expect(baks).toEqual([]);
});

test("stale .bak.v1.* is removed before new bak is written", async () => {
  writeFileSync(join(tmp, "memory.json"), JSON.stringify(v1MemorySample));
  writeFileSync(
    join(tmp, "memory.json.bak.v1.999"),
    JSON.stringify({ stale: true }),
  );
  await migrateAll(tmp);
  const baks = readdirSync(tmp).filter((e) =>
    /^memory\.json\.bak\.v1\.\d+$/.test(e),
  );
  expect(baks).toHaveLength(1);
  expect(baks[0]).not.toBe("memory.json.bak.v1.999");
});
