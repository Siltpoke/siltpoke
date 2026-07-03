import { describe, expect, test } from "bun:test";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import { pruneStaleFacts } from "../../src/memory/prune";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-16T00:00:00Z");

function makeMemory(facts: Fact[] = []): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: {
      snark: 0,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
    },
    last_consolidated_at: "2026-01-01T00:00:00Z",
    consolidation_due_at: "2026-01-08T00:00:00Z",
    user_profile: {
      communication_style: "neutral",
      goals: [],
      constraints: [],
      prefs: {},
    },
    chat_sessions: [],
    facts,
    event_fragments: [],
    episodes: [],
  };
}

function daysAgo(n: number, from: Date = NOW): string {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeActiveFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-active-001",
    text: "Some active fact.",
    source_session_id: null,
    confidence: 0.8,
    status: "active",
    created_at: daysAgo(100),
    last_seen_at: daysAgo(100),
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
    ...overrides,
  };
}

function makePendingFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-pending-001",
    text: "Pending fact awaiting approval.",
    source_session_id: null,
    confidence: 0.75,
    status: "pending",
    created_at: daysAgo(35),
    last_seen_at: daysAgo(35),
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
    ...overrides,
  };
}

// Alias for clarity in tests that focus on the memory container
const memoryWith = makeMemory;

function makeRetiredFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-retired-001",
    text: "Old retired fact.",
    source_session_id: null,
    confidence: 0.3,
    status: "retired",
    created_at: daysAgo(200),
    last_seen_at: daysAgo(200),
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: "superseded",
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Active fact pruning (superseded by decay sweep)
// Active facts are now handled by proposeDecayedFacts (decay.ts); prune leaves them.
// ---------------------------------------------------------------------------

describe("active fact pruning (now delegated to decay sweep)", () => {
  test("leaves stale low-confidence active facts to the decay sweep (no longer hard-retired here)", () => {
    const stale = {
      id: "f-old", text: "x", source_session_id: null, confidence: 0.3,
      status: "active" as const,
      created_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-01-01T00:00:00.000Z",
      supersedes: null, superseded_by: null, pinned: false, recall_count: 0,
      retired_reason: null,
      stability: "durable" as const,
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    };
    const now = new Date("2026-06-24T00:00:00.000Z");
    const { memory, result } = pruneStaleFacts(memoryWith([stale]), now);
    expect(memory.facts[0]?.status).toBe("active");
    expect(result.factsPruned).toBe(0);
  });

  test("fresh active fact is left untouched", () => {
    const fact = makeActiveFact({
      last_seen_at: daysAgo(10),
      confidence: 0.9,
    });
    const { result } = pruneStaleFacts(makeMemory([fact]), NOW);
    expect(result.factsPruned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pending fact pruning (PQ7: >30d → pending_too_long)
// ---------------------------------------------------------------------------

describe("pending fact pruning", () => {
  test("at 31d → pruned with pending_too_long", () => {
    const fact = makePendingFact({ created_at: daysAgo(31) });
    const { memory, result } = pruneStaleFacts(makeMemory([fact]), NOW);
    expect(result.pendingPruned).toBe(1);
    const pruned = memory.facts.find((f) => f.id === fact.id);
    expect(pruned?.status).toBe("retired");
    expect(pruned?.retired_reason).toBe("pending_too_long");
  });

  test("at exactly 30d → NOT pruned (strict inequality)", () => {
    const fact = makePendingFact({ created_at: daysAgo(30) });
    const { result } = pruneStaleFacts(makeMemory([fact]), NOW);
    expect(result.pendingPruned).toBe(0);
  });

  test("at 29d → NOT pruned", () => {
    const fact = makePendingFact({ created_at: daysAgo(29) });
    const { result } = pruneStaleFacts(makeMemory([fact]), NOW);
    expect(result.pendingPruned).toBe(0);
  });

  test("pending fact is never hard-deleted", () => {
    const fact = makePendingFact({ created_at: daysAgo(365) });
    const { memory } = pruneStaleFacts(makeMemory([fact]), NOW);
    // Fact still exists in array, just status changed
    expect(memory.facts).toHaveLength(1);
    expect(memory.facts[0]?.status).toBe("retired");
  });
});

// ---------------------------------------------------------------------------
// Retired facts untouched
// ---------------------------------------------------------------------------

describe("retired facts", () => {
  test("retired fact is not modified", () => {
    const fact = makeRetiredFact({
      last_seen_at: daysAgo(300),
      confidence: 0.1,
    });
    const { memory, result } = pruneStaleFacts(makeMemory([fact]), NOW);
    expect(result.factsPruned).toBe(0);
    expect(result.pendingPruned).toBe(0);
    expect(memory.facts[0]?.status).toBe("retired");
    expect(memory.facts[0]?.retired_reason).toBe("superseded");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  test("input memory is not mutated", () => {
    const fact = makeActiveFact({
      last_seen_at: daysAgo(91),
      confidence: 0.3,
    });
    const mem = makeMemory([fact]);
    const originalStatus = mem.facts[0]?.status;
    pruneStaleFacts(mem, NOW);
    expect(mem.facts[0]?.status).toBe(originalStatus);
  });

  test("returned memory is a new object reference", () => {
    const mem = makeMemory();
    const { memory } = pruneStaleFacts(mem, NOW);
    expect(memory).not.toBe(mem);
  });
});

// ---------------------------------------------------------------------------
// Mixed states
// ---------------------------------------------------------------------------

describe("mixed states", () => {
  test("mix of active/pending/retired → counts correct (active untouched, pending still pruned)", () => {
    const facts: Fact[] = [
      // stale active low-conf → LEFT to decay sweep (factsPruned stays 0)
      makeActiveFact({
        id: "f-1",
        last_seen_at: daysAgo(91),
        confidence: 0.3,
      }),
      // fresh active high-conf → kept
      makeActiveFact({
        id: "f-2",
        last_seen_at: daysAgo(10),
        confidence: 0.9,
      }),
      // stale active but high-conf → kept
      makeActiveFact({
        id: "f-3",
        last_seen_at: daysAgo(95),
        confidence: 0.8,
      }),
      // stale pending → pruned (pendingPruned++)
      makePendingFact({
        id: "f-4",
        created_at: daysAgo(31),
      }),
      // fresh pending → kept
      makePendingFact({
        id: "f-5",
        created_at: daysAgo(20),
      }),
      // retired → untouched
      makeRetiredFact({ id: "f-6" }),
    ];

    const { result, memory } = pruneStaleFacts(makeMemory(facts), NOW);
    expect(result.factsPruned).toBe(0);
    expect(result.pendingPruned).toBe(1);
    // All 6 facts still present (never deleted)
    expect(memory.facts).toHaveLength(6);
    // stale active fact stays active (decay sweep will handle it)
    expect(memory.facts.find((f) => f.id === "f-1")?.status).toBe("active");
  });
});
