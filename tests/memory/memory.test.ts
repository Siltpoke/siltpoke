import { test, expect, describe, it, beforeEach, afterEach } from "bun:test";
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
  readMemory,
  writeMemory,
  emptyMemory,
  appendLearnedRule,
  newId,
  goalSchema,
  factSchema,
  factEventSchema,
  chatSessionSchema,
  userProfileSchema,
  coreMemorySchema,
  type CoreMemory,
  type LearnedRule,
  type FactEvent,
} from "../../src/memory/memory";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-mem-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sample: CoreMemory = {
  schemaVersion: 2,
  long_term_summary: "User likes terse feedback.",
  learned_rules: [
    {
      id: "lr-001",
      rule: "Grep for existing null checks first.",
      category: "null_check",
      created_at: "2026-05-14T00:00:00Z",
      applied_count: 3,
      effectiveness: "good",
    },
  ],
  personality_drift: {
    snark: 0,
    patience: 0,
    style_strictness: 0,
    proactivity: 0,
  },
  last_consolidated_at: "2026-05-14T00:00:00Z",
  consolidation_due_at: "2026-05-21T00:00:00Z",
  user_profile: {
    communication_style: "neutral",
    goals: [],
    constraints: [],
    prefs: {},
  },
  chat_sessions: [],
  facts: [],
  event_fragments: [],
  episodes: [],
};

test("readMemory returns null when file missing", async () => {
  expect(await readMemory(tmp)).toBeNull();
});

test("writeMemory creates a JSON file readable by readMemory", async () => {
  await writeMemory(tmp, sample);
  const got = await readMemory(tmp);
  expect(got?.long_term_summary).toBe("User likes terse feedback.");
  expect(got?.learned_rules.length).toBe(1);
});

test("readMemory quarantines malformed JSON and returns null", async () => {
  writeFileSync(join(tmp, "memory.json"), "not json");
  expect(await readMemory(tmp)).toBeNull();
  const entries = readdirSync(tmp);
  const corrupt = entries.find((e) =>
    /^memory\.json\.corrupt-\d+$/.test(e),
  );
  expect(corrupt).toBeDefined();
  expect(entries.includes("memory.json")).toBe(false);
});

test("readMemory quarantines schema-failing JSON and returns null", async () => {
  writeFileSync(
    join(tmp, "memory.json"),
    JSON.stringify({ ...sample, schemaVersion: 99 }),
  );
  expect(await readMemory(tmp)).toBeNull();
  const entries = readdirSync(tmp);
  const corrupt = entries.find((e) =>
    /^memory\.json\.corrupt-\d+$/.test(e),
  );
  expect(corrupt).toBeDefined();
});

test("emptyMemory returns schema-valid v2 defaults", () => {
  const m = emptyMemory();
  expect(m.schemaVersion).toBe(2);
  expect(m.learned_rules).toEqual([]);
  expect(m.personality_drift.snark).toBe(0);
  expect(m.user_profile.communication_style).toBe("neutral");
  expect(m.user_profile.goals).toEqual([]);
  expect(m.user_profile.constraints).toEqual([]);
  expect(m.chat_sessions).toEqual([]);
  expect(m.facts).toEqual([]);
  expect(coreMemorySchema.safeParse(m).success).toBe(true);
});

test("concurrent writes do not corrupt file", async () => {
  const a: CoreMemory = { ...sample, long_term_summary: "version A" };
  const b: CoreMemory = { ...sample, long_term_summary: "version B" };
  await Promise.all([writeMemory(tmp, a), writeMemory(tmp, b)]);
  const got = await readMemory(tmp);
  expect(got).not.toBeNull();
  expect(["version A", "version B"]).toContain(got!.long_term_summary);
});

test("write then re-read preserves structure exactly", async () => {
  await writeMemory(tmp, sample);
  const raw = readFileSync(join(tmp, "memory.json"), "utf8");
  expect(JSON.parse(raw).learned_rules[0].id).toBe("lr-001");
});

const newRule: LearnedRule = {
  id: "lr-new1",
  rule: "Before flagging NULL handling, grep for existing checks.",
  category: "null_check",
  created_at: "2026-05-14T12:00:00Z",
  applied_count: 0,
  effectiveness: "good",
};

test("appendLearnedRule: first append creates memory file with rule", async () => {
  const result = await appendLearnedRule(tmp, newRule);
  expect(result.appended).toBe(true);
  expect(result.rule_id).toBe("lr-new1");
  const mem = await readMemory(tmp);
  expect(mem!.learned_rules).toHaveLength(1);
  expect(mem!.learned_rules[0]!.id).toBe("lr-new1");
});

test("appendLearnedRule: dedupes by (category, rule) case-insensitive", async () => {
  await appendLearnedRule(tmp, newRule);
  const dup: LearnedRule = {
    ...newRule,
    id: "lr-different-id",
    rule: "  before flagging NULL handling, grep for EXISTING checks. ",
  };
  const result = await appendLearnedRule(tmp, dup);
  expect(result.appended).toBe(false);
  expect(result.reason).toBe("duplicate");
  expect(result.rule_id).toBe("lr-new1");
  const mem = await readMemory(tmp);
  expect(mem!.learned_rules).toHaveLength(1);
});

test("appendLearnedRule: different category bypasses dedupe", async () => {
  await appendLearnedRule(tmp, newRule);
  const other: LearnedRule = { ...newRule, id: "lr-2", category: "import_path" };
  const result = await appendLearnedRule(tmp, other);
  expect(result.appended).toBe(true);
  const mem = await readMemory(tmp);
  expect(mem!.learned_rules).toHaveLength(2);
});

// --- v2 schema tests ---

test("newId produces prefixed 8-char hex", () => {
  const id = newId("g");
  expect(id).toMatch(/^g-[0-9a-f]{8}$/);
});

test("newId produces 1000 unique IDs", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) ids.add(newId("f"));
  expect(ids.size).toBe(1000);
});

test("goalSchema rejects invalid status enum", () => {
  const bad = {
    id: "g-12345678",
    text: "ship the release",
    created_at: "2026-05-15T00:00:00Z",
    status: "in_progress",
  };
  expect(goalSchema.safeParse(bad).success).toBe(false);
});

test("goalSchema accepts valid statuses", () => {
  for (const status of ["active", "paused", "done"] as const) {
    const ok = {
      id: "g-12345678",
      text: "x",
      created_at: "2026-05-15T00:00:00Z",
      status,
    };
    expect(goalSchema.safeParse(ok).success).toBe(true);
  }
});

test("factSchema rejects confidence > 1", () => {
  const bad = {
    id: "f-12345678",
    text: "user prefers terse",
    source_session_id: null,
    confidence: 1.5,
    created_at: "2026-05-15T00:00:00Z",
    last_seen_at: "2026-05-15T00:00:00Z",
    supersedes: null,
  };
  expect(factSchema.safeParse(bad).success).toBe(false);
});

test("factSchema rejects confidence < 0", () => {
  const bad = {
    id: "f-12345678",
    text: "x",
    source_session_id: null,
    confidence: -0.1,
    created_at: "2026-05-15T00:00:00Z",
    last_seen_at: "2026-05-15T00:00:00Z",
    supersedes: null,
  };
  expect(factSchema.safeParse(bad).success).toBe(false);
});

test("factSchema status defaults to pending", () => {
  const minimal = {
    id: "f-12345678",
    text: "x",
    source_session_id: null,
    confidence: 0.8,
    created_at: "2026-05-15T00:00:00Z",
    last_seen_at: "2026-05-15T00:00:00Z",
    supersedes: null,
  };
  const parsed = factSchema.parse(minimal);
  expect(parsed.status).toBe("pending");
});

test("factSchema retired_reason defaults to null", () => {
  const minimal = {
    id: "f-12345678",
    text: "x",
    source_session_id: null,
    confidence: 0.8,
    created_at: "2026-05-15T00:00:00Z",
    last_seen_at: "2026-05-15T00:00:00Z",
    supersedes: null,
  };
  const parsed = factSchema.parse(minimal);
  expect(parsed.retired_reason).toBeNull();
});

test("factSchema accepts all retired_reason enum values", () => {
  for (const reason of [
    "superseded",
    "user_rejected",
    "low_confidence_pruned",
  ] as const) {
    const ok = {
      id: "f-12345678",
      text: "x",
      source_session_id: null,
      confidence: 0.8,
      status: "retired" as const,
      created_at: "2026-05-15T00:00:00Z",
      last_seen_at: "2026-05-15T00:00:00Z",
      supersedes: null,
      retired_reason: reason,
    };
    expect(factSchema.safeParse(ok).success).toBe(true);
  }
});

test("chatSessionSchema requires all fields", () => {
  const minimal = {
    id: "s-12345678",
    started_at: "2026-05-15T00:00:00Z",
    ended_at: null,
    message_count: 0,
    summary: "",
    tags: [],
  };
  expect(chatSessionSchema.safeParse(minimal).success).toBe(true);
  // missing summary
  const bad = { ...minimal } as Partial<typeof minimal>;
  delete bad.summary;
  expect(chatSessionSchema.safeParse(bad).success).toBe(false);
});

test("userProfileSchema applies defaults from empty object", () => {
  const parsed = userProfileSchema.parse({});
  expect(parsed.communication_style).toBe("neutral");
  expect(parsed.goals).toEqual([]);
  expect(parsed.constraints).toEqual([]);
  expect(parsed.prefs).toEqual({});
  expect(parsed.name).toBeUndefined();
});

test("coreMemorySchema rejects schemaVersion 1 (v2 only)", () => {
  const v1Shape = {
    schemaVersion: 1,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: "2026-05-15T00:00:00Z",
    consolidation_due_at: "2026-05-15T00:00:00Z",
  };
  expect(coreMemorySchema.safeParse(v1Shape).success).toBe(false);
});

describe("factSchema decay fields", () => {
  const base = {
    id: "f-1",
    text: "uses bun",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    last_seen_at: "2026-06-01T00:00:00.000Z",
    supersedes: null,
    retired_reason: null,
  };

  it("defaults new fields for legacy facts missing them", () => {
    const f = factSchema.parse(base);
    expect(f.pinned).toBe(false);
    expect(f.recall_count).toBe(0);
    expect(f.superseded_by).toBe(null);
  });

  it("accepts the new retire_proposed status", () => {
    const f = factSchema.parse({ ...base, status: "retire_proposed" });
    expect(f.status).toBe("retire_proposed");
  });

  it("accepts the new decayed retired_reason", () => {
    const f = factSchema.parse({ ...base, status: "retired", retired_reason: "decayed" });
    expect(f.retired_reason).toBe("decayed");
  });

  it("rejects negative recall_count", () => {
    expect(() => factSchema.parse({ ...base, recall_count: -1 })).toThrow();
  });
});

describe("factEventSchema", () => {
  it("validates an action entry with required fields", () => {
    const e = factEventSchema.parse({ action: "created", at: "2026-06-26T00:00:00Z" });
    expect(e.action).toBe("created");
    expect(e.at).toBe("2026-06-26T00:00:00Z");
    expect(e.reason).toBeNull();
  });

  it("validates all action enum values", () => {
    for (const action of ["created", "approved", "reaffirmed", "retired", "reactivated"] as const) {
      const e = factEventSchema.parse({ action, at: "2026-06-26T00:00:00Z" });
      expect(e.action).toBe(action);
    }
  });

  it("accepts reason as a string", () => {
    const e = factEventSchema.parse({ action: "retired", at: "2026-06-26T00:00:00Z", reason: "superseded" });
    expect(e.reason).toBe("superseded");
  });

  it("rejects invalid action enum", () => {
    expect(() =>
      factEventSchema.parse({ action: "invalid", at: "2026-06-26T00:00:00Z" }),
    ).toThrow();
  });
});

describe("factSchema lifecycle fields", () => {
  // A legacy-shaped fact identical to a real persisted ~/.siltpoke/projects/<hash>/memory.json
  // fact (verified 38f0506459288c56) — WITHOUT the 4 new lifecycle fields.
  const legacy = {
    id: "f-1a475f99",
    text: "the user prefers responses in Chinese rather than English",
    source_session_id: null,
    confidence: 0.95,
    status: "active",
    created_at: "2026-06-25T04:52:38.897Z",
    last_seen_at: "2026-06-25T04:52:38.897Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
  };

  it("round-trips a legacy fact + applies lifecycle defaults (no migration)", () => {
    const f = factSchema.parse(legacy);
    expect(f.stability).toBe("durable");
    expect(f.learned_from).toBe(null);
    expect(f.last_confirmed_at).toBe(null);
    expect(f.expires_at).toBe(null);
  });

  it("accepts an explicit stability + learned_from struct", () => {
    const f = factSchema.parse({
      ...legacy,
      stability: "permanent",
      learned_from: { stream: "chat", session_id: "s1" },
      last_confirmed_at: "2026-06-25T05:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
    });
    expect(f.stability).toBe("permanent");
    expect(f.learned_from).toEqual({ stream: "chat", session_id: "s1" });
    expect(f.last_confirmed_at).toBe("2026-06-25T05:00:00.000Z");
    expect(f.expires_at).toBe("2026-12-31T00:00:00.000Z");
  });

  it("rejects an invalid stability enum value", () => {
    expect(() =>
      factSchema.parse({ ...legacy, stability: "forever" }),
    ).toThrow();
  });

  it("rejects an invalid learned_from stream", () => {
    expect(() =>
      factSchema.parse({
        ...legacy,
        learned_from: { stream: "telepathy", session_id: null },
      }),
    ).toThrow();
  });
});

describe("factSchema events[] action-log field (Task 1)", () => {
  // Legacy fact WITHOUT events field (pre-Memory Book Action-Log feature)
  const legacyNoEvents = {
    id: "f-1a475f99",
    text: "the user prefers responses in Chinese rather than English",
    source_session_id: null,
    confidence: 0.95,
    status: "active",
    created_at: "2026-06-25T04:52:38.897Z",
    last_seen_at: "2026-06-25T04:52:38.897Z",
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
  };

  it("legacy fact without events parses with events: []", () => {
    const f = factSchema.parse(legacyNoEvents);
    expect(Array.isArray(f.events)).toBe(true);
    expect(f.events).toEqual([]);
  });

  it("fact with events round-trips", () => {
    const withEvents = {
      ...legacyNoEvents,
      events: [
        { action: "created" as const, at: "2026-06-25T04:52:38.897Z", reason: null },
        { action: "approved" as const, at: "2026-06-25T04:55:00.000Z", reason: null },
      ],
    };
    const f = factSchema.parse(withEvents);
    expect(f.events).toHaveLength(2);
    expect(f.events[0]?.action).toBe("created");
    expect(f.events[1]?.action).toBe("approved");
  });
});

test("readMemory parses v2 file with full new fields populated", async () => {
  const full: CoreMemory = {
    ...sample,
    user_profile: {
      name: "Vic",
      communication_style: "terse",
      goals: [
        {
          id: "g-aaaaaaaa",
          text: "ship the release",
          created_at: "2026-05-15T00:00:00Z",
          status: "active",
        },
      ],
      constraints: ["no UI work yet"],
      prefs: { theme: "dark" },
    },
    chat_sessions: [
      {
        id: "s-bbbbbbbb",
        started_at: "2026-05-15T01:00:00Z",
        ended_at: null,
        message_count: 5,
        summary: "discussed schema",
        summary_generated_at: null,
        tags: ["legacy-tag-c"],
        anchor: null,
      },
    ],
    facts: [
      {
        id: "f-cccccccc",
        text: "user prefers Bun",
        source_session_id: "s-bbbbbbbb",
        confidence: 0.9,
        status: "active",
        created_at: "2026-05-15T01:30:00Z",
        last_seen_at: "2026-05-15T01:30:00Z",
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
  };
  await writeMemory(tmp, full);
  const got = await readMemory(tmp);
  expect(got).not.toBeNull();
  expect(got!.user_profile.name).toBe("Vic");
  expect(got!.user_profile.goals[0]!.id).toBe("g-aaaaaaaa");
  expect(got!.chat_sessions[0]!.summary).toBe("discussed schema");
  expect(got!.facts[0]!.confidence).toBe(0.9);
  expect(got!.facts[0]!.status).toBe("active");
});
