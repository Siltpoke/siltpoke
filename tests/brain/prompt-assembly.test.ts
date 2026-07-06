import { expect, test } from "bun:test";
import { assembleSystemPrompt } from "../../src/brain/prompt-assembly";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import type { RecentEntry } from "../../src/memory/recent";

const personality = "You are Siltpoke. Be terse.";

const sampleMemory: CoreMemory = {
  schemaVersion: 2,
  long_term_summary: "User prefers terse feedback.",
  learned_rules: [
    {
      id: "lr-001",
      rule: "Always grep for existing null checks first.",
      category: "null_check",
      created_at: "2026-05-14T00:00:00Z",
      applied_count: 0,
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

const sampleRecent: RecentEntry[] = [
  {
    ts: "2026-05-14T10:00:00Z",
    critique_id: "c-aaaa",
    verdict: "dismissed",
    reason: "already had null check",
    file: "queries.py",
    line: 47,
  },
];

test("null memory + empty recent: returns personality prompt unchanged", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
  });
  expect(out).toBe(personality);
});

test("memory block follows personality, recent block follows memory", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: sampleMemory,
    recent: sampleRecent,
  });
  const personalityIdx = out.indexOf(personality);
  const memoryIdx = out.indexOf("<core_memory>");
  const recentIdx = out.indexOf("<recent_feedback>");
  expect(personalityIdx).toBeLessThan(memoryIdx);
  expect(memoryIdx).toBeLessThan(recentIdx);
});

test("memory block contains long_term_summary and learned rules", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: sampleMemory,
    recent: [],
  });
  expect(out).toContain("User prefers terse feedback");
  expect(out).toContain("Always grep for existing null checks first");
  expect(out).toContain("null_check");
});

test("retired rules are filtered out", () => {
  const memWithRetired: CoreMemory = {
    ...sampleMemory,
    learned_rules: [
      ...sampleMemory.learned_rules,
      {
        id: "lr-002",
        rule: "RETIRED RULE THAT SHOULD NOT APPEAR",
        category: "old",
        created_at: "2026-01-01T00:00:00Z",
        applied_count: 0,
        effectiveness: "retired",
      },
    ],
  };
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: memWithRetired,
    recent: [],
  });
  expect(out).not.toContain("RETIRED RULE");
  expect(out).toContain("Always grep");
});

test("empty memory (no summary, no active rules) skips core_memory block", () => {
  const empty: CoreMemory = {
    ...sampleMemory,
    long_term_summary: "",
    learned_rules: [],
  };
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: empty,
    recent: [],
  });
  expect(out).not.toContain("<core_memory>");
});

test("recent block renders verdict and file:line", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: sampleRecent,
  });
  expect(out).toContain("c-aaaa");
  expect(out).toContain("dismissed");
  expect(out).toContain("queries.py:47");
  expect(out).toContain("already had null check");
});

test("ordering invariant: personality always first even when only recent is set", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: sampleRecent,
  });
  expect(out.startsWith(personality)).toBe(true);
});

test("rules filtered out by file type do not appear in prompt", () => {
  const memWithTyped: CoreMemory = {
    ...sampleMemory,
    learned_rules: [
      {
        id: "lr-py",
        rule: "PYTHON-ONLY RULE",
        category: "py_specific",
        created_at: "2026-05-14T00:00:00Z",
        applied_count: 0,
        effectiveness: "good",
        // @ts-expect-error — extension field not in base type but tolerated
        applies_to_file_types: ["py"],
      },
      {
        id: "lr-univ",
        rule: "UNIVERSAL RULE",
        category: "general",
        created_at: "2026-05-14T00:00:00Z",
        applied_count: 0,
        effectiveness: "good",
      },
    ],
  };
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: memWithTyped,
    recent: [],
    fileTypes: new Set(["ts"]),
  });
  expect(out).not.toContain("PYTHON-ONLY RULE");
  expect(out).toContain("UNIVERSAL RULE");
});

test("recent injection respects recentInjectionCount cap", () => {
  const many: RecentEntry[] = Array.from({ length: 10 }, (_, i) => ({
    ts: `2026-05-14T10:0${i}:00Z`,
    critique_id: `c-${i}`,
    verdict: "dismissed",
    reason: `reason ${i}`,
  }));
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: many,
    recentInjectionCount: 3,
  });
  // Only the 3 most recent (c-7, c-8, c-9) should appear.
  expect(out).toContain("c-7");
  expect(out).toContain("c-8");
  expect(out).toContain("c-9");
  expect(out).not.toContain("c-0");
  expect(out).not.toContain("c-6");
});

// ---------------------------------------------------------------------------
// Tool-output integration cases
// ---------------------------------------------------------------------------

test("(regression) no toolOutputSection: existing callers still get identical output", () => {
  // Calling without toolOutputSection should be identical to legacy baseline behavior
  const out1 = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: sampleMemory,
    recent: sampleRecent,
  });
  const out2 = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: sampleMemory,
    recent: sampleRecent,
    toolOutputSection: undefined,
  });
  expect(out1).toBe(out2);
});

test("toolOutputSection appended after existing blocks when provided", () => {
  const toolSection = "## Tool output\n\nSome tool findings here.";
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: sampleMemory,
    recent: sampleRecent,
    toolOutputSection: toolSection,
  });

  // Tool section is appended
  expect(out).toContain(toolSection);

  // Personality still comes first
  expect(out.startsWith(personality)).toBe(true);

  // Tool section comes after existing blocks
  const recentIdx = out.indexOf("<recent_feedback>");
  const toolIdx = out.indexOf(toolSection);
  expect(recentIdx).toBeLessThan(toolIdx);
});

// ---------------------------------------------------------------------------
// Anti-examples (few-shot retrieval) integration cases
// ---------------------------------------------------------------------------

test("antiExamplesBlock omitted → no change to output (regression)", () => {
  const out1 = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
  });
  const out2 = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
    antiExamplesBlock: undefined,
  });
  expect(out1).toBe(out2);
});

test("antiExamplesBlock empty string → not appended", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
    antiExamplesBlock: "",
  });
  expect(out).not.toContain("dismissed");
});

test("antiExamplesBlock appended after toolOutputSection when both provided", () => {
  const toolSection = "## Tool output\n\nfindings.";
  const antiBlock = "## User dismissed similar past critiques\n\nsome dismissed critique";
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: sampleMemory,
    recent: sampleRecent,
    toolOutputSection: toolSection,
    antiExamplesBlock: antiBlock,
  });

  expect(out).toContain(antiBlock);

  const toolIdx = out.indexOf(toolSection);
  const antiIdx = out.indexOf(antiBlock);
  expect(toolIdx).toBeLessThan(antiIdx);
});

test("antiExamplesBlock appears in output with correct header", () => {
  const antiBlock = "## User dismissed similar past critiques\n\n[Dismissed earlier — similarity 0.92] foo critique";
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
    antiExamplesBlock: antiBlock,
  });
  expect(out).toContain("User dismissed similar past critiques");
  expect(out).toContain("similarity 0.92");
});

test("callerImpactSection appears in output when provided, after toolOutputSection", () => {
  const toolSection = "## Tool output\n\nsome tsc output";
  const callerSection = "## Caller impact (1-hop, structural)\n\ncaller: src/bar.ts:42";
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
    toolOutputSection: toolSection,
    callerImpactSection: callerSection,
  });
  expect(out).toContain("Caller impact (1-hop, structural)");
  expect(out).toContain("caller: src/bar.ts:42");
  expect(out.indexOf(toolSection)).toBeLessThan(out.indexOf(callerSection));
});

test("callerImpactSection absent from output when omitted", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
  });
  expect(out).not.toContain("Caller impact");
});

test("empty callerImpactSection is not injected", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: null,
    recent: [],
    callerImpactSection: "",
  });
  expect(out).toBe(personality);
});

// ── Brain recalls style facts, never profile ──

function mkFact(over: Partial<Fact>): Fact {
  return {
    id: "f-1",
    text: "x",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-29T00:00:00Z",
    last_seen_at: "2026-06-29T00:00:00Z",
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
    kind: null,
    ...over,
  };
}

// empty summary + no rules — today's real critic state. Only facts vary.
const bareMem = (facts: Fact[]): CoreMemory => ({
  ...sampleMemory,
  long_term_summary: "",
  learned_rules: [],
  facts,
});

test("a style fact alone fires <core_memory> + the style section (empty summary + no rules)", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: bareMem([
      mkFact({ id: "zh", text: "The user prefers concise answers", kind: "style" }),
    ]),
    recent: [],
  });
  expect(out).toContain("<core_memory>");
  expect(out).toContain("## User communication style");
  expect(out).toContain("The user prefers concise answers");
});

test("profile + untagged facts never reach the critic (no leak, no fire)", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: bareMem([
      mkFact({ id: "dan", text: "User's partner is Alex", kind: "profile" }),
      mkFact({ id: "u", text: "User likes dogs", kind: null }),
    ]),
    recent: [],
  });
  // no style facts → block doesn't fire on profile/untagged at all
  expect(out).toBe(personality);
  expect(out).not.toContain("Alex");
  expect(out).not.toContain("dogs");
});

test("style injected, profile sibling in the same store stays out", () => {
  const out = assembleSystemPrompt({
    personalitySystemPrompt: personality,
    memory: bareMem([
      mkFact({ id: "zh", text: "The user prefers concise answers", kind: "style" }),
      mkFact({ id: "dan", text: "User's partner is Alex", kind: "profile" }),
    ]),
    recent: [],
  });
  expect(out).toContain("concise");
  expect(out).not.toContain("Alex");
});
