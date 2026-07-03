import { test, expect, describe } from "bun:test";
import { applyCandidates } from "../../src/memory/apply-candidates";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import type { Candidate } from "../../src/memory/summarizer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-16T12:00:00Z");

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

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-test-001",
    text: "User prefers terse feedback.",
    source_session_id: null,
    confidence: 0.85,
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
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    action: "add",
    candidate_claim: "User writes TypeScript.",
    evidence_quote: null,
    suggested_confidence: 0.95,
    supersedes_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// add action
// ---------------------------------------------------------------------------

describe("add action", () => {
  test("confidence >= 0.9 → added with status=pending (pending-first, global)", () => {
    const mem = makeMemory();
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ suggested_confidence: 0.95 })],
      NOW,
    );
    expect(result.added).toBe(1);
    expect(result.discarded).toBe(0);
    const newFact = memory.facts.find((f) => f.text === "User writes TypeScript.");
    expect(newFact).toBeDefined();
    // Newly-added facts land pending regardless of confidence; only
    // /siltpoke-approve or user-pin/ /remember produce active.
    expect(newFact?.status).toBe("pending");
  });

  test("confidence 0.7 → added with status=pending", () => {
    const mem = makeMemory();
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ suggested_confidence: 0.7 })],
      NOW,
    );
    expect(result.added).toBe(1);
    const newFact = memory.facts.find((f) => f.text === "User writes TypeScript.");
    expect(newFact?.status).toBe("pending");
  });

  test("confidence 0.89 → added with status=pending", () => {
    const { memory, result } = applyCandidates(
      makeMemory(),
      [makeCandidate({ suggested_confidence: 0.89 })],
      NOW,
    );
    expect(result.added).toBe(1);
    expect(memory.facts[0]?.status).toBe("pending");
  });

  test("confidence < 0.7 → discarded, not added", () => {
    const mem = makeMemory();
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ suggested_confidence: 0.69 })],
      NOW,
    );
    expect(result.added).toBe(0);
    expect(result.discarded).toBe(1);
    expect(memory.facts).toHaveLength(0);
  });

  test("add sets created_at and last_seen_at to now", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ suggested_confidence: 0.95 })],
      NOW,
    );
    expect(memory.facts[0]?.created_at).toBe(NOW.toISOString());
    expect(memory.facts[0]?.last_seen_at).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// provenance (the null-drop corner fix)
// ---------------------------------------------------------------------------

describe("provenance (learned_from)", () => {
  test("add candidate carrying source → fact learned_from populated (not null)", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [
        makeCandidate({
          suggested_confidence: 0.95,
          source: { stream: "chat", session_id: "s1" },
        }),
      ],
      NOW,
    );
    const f = memory.facts.find((x) => x.text === "User writes TypeScript.");
    expect(f?.learned_from).toEqual({ stream: "chat", session_id: "s1" });
    // back-compat: legacy source_session_id backfilled from the same source.
    expect(f?.source_session_id).toBe("s1");
  });

  test("add candidate WITHOUT source → learned_from null (no fabrication)", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ suggested_confidence: 0.95 })],
      NOW,
    );
    expect(memory.facts[0]?.learned_from).toBeNull();
    expect(memory.facts[0]?.source_session_id).toBeNull();
  });

  test("add candidate with stream='commit' → learned_from.stream equals 'commit', session_id null (end-to-end provenance for coding-activity facts)", () => {
    // This proves the full pipeline: Brain emitting source.stream="commit" (now
    // instructed by the summarizer prompt fix) produces a fact tagged stream="commit".
    const { memory } = applyCandidates(
      makeMemory(),
      [
        makeCandidate({
          suggested_confidence: 0.95,
          source: { stream: "commit", session_id: null },
        }),
      ],
      NOW,
    );
    const f = memory.facts.find((x) => x.text === "User writes TypeScript.");
    expect(f?.learned_from).toEqual({ stream: "commit", session_id: null });
    // back-compat: commit-derived → source_session_id null
    expect(f?.source_session_id).toBeNull();
  });

  test("update candidate carrying source → new fact learned_from populated", () => {
    const existing = makeFact({ id: "f-old", text: "old claim" });
    const { memory } = applyCandidates(
      makeMemory([existing]),
      [
        makeCandidate({
          action: "update",
          candidate_claim: "new claim",
          suggested_confidence: 0.95,
          supersedes_id: "f-old",
          source: { stream: "critique", session_id: null },
        }),
      ],
      NOW,
    );
    const f = memory.facts.find((x) => x.text === "new claim");
    expect(f?.learned_from).toEqual({ stream: "critique", session_id: null });
  });
});

// ---------------------------------------------------------------------------
// skip action
// ---------------------------------------------------------------------------

describe("skip action", () => {
  test("valid id → last_seen_at bumped", () => {
    const oldDate = "2025-01-01T00:00:00Z";
    const fact = makeFact({ id: "f-001", last_seen_at: oldDate });
    const mem = makeMemory([fact]);
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ action: "skip", supersedes_id: "f-001", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.skipped).toBe(1);
    expect(result.discarded).toBe(0);
    const updated = memory.facts.find((f) => f.id === "f-001");
    expect(updated?.last_seen_at).toBe(NOW.toISOString());
  });

  test("unknown id → discarded, no crash", () => {
    const mem = makeMemory();
    const { result } = applyCandidates(
      mem,
      [makeCandidate({ action: "skip", supersedes_id: "f-nonexistent", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.discarded).toBe(1);
    expect(result.skipped).toBe(0);
  });

  // skip vs retire_proposed override. The deterministic decay sweep marks
  // stale facts `retire_proposed`; a later summarizer `skip` naming
  // that fact means "still relevant" and must override the retirement proposal.
  test("retire_proposed fact + skip → restored to active, last_seen_at refreshed", () => {
    const oldDate = "2025-01-01T00:00:00Z";
    const fact = makeFact({ id: "f-001", status: "retire_proposed", last_seen_at: oldDate });
    const mem = makeMemory([fact]);
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ action: "skip", supersedes_id: "f-001", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.skipped).toBe(1);
    const updated = memory.facts.find((f) => f.id === "f-001");
    expect(updated?.status).toBe("active");
    expect(updated?.last_seen_at).toBe(NOW.toISOString());
  });

  test("active fact + skip → status stays active, last_seen_at refreshed (unchanged behavior)", () => {
    const oldDate = "2025-01-01T00:00:00Z";
    const fact = makeFact({ id: "f-001", status: "active", last_seen_at: oldDate });
    const mem = makeMemory([fact]);
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ action: "skip", supersedes_id: "f-001", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.skipped).toBe(1);
    const updated = memory.facts.find((f) => f.id === "f-001");
    expect(updated?.status).toBe("active");
    expect(updated?.last_seen_at).toBe(NOW.toISOString());
  });

  test("pending fact + skip → status stays pending (NOT auto-activated, guards pending-first invariant)", () => {
    const fact = makeFact({ id: "f-001", status: "pending" });
    const mem = makeMemory([fact]);
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ action: "skip", supersedes_id: "f-001", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.skipped).toBe(1);
    const updated = memory.facts.find((f) => f.id === "f-001");
    expect(updated?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// retire action
// ---------------------------------------------------------------------------

describe("retire action", () => {
  test("valid id → fact retired with reason=superseded", () => {
    const fact = makeFact({ id: "f-001" });
    const mem = makeMemory([fact]);
    const { memory, result } = applyCandidates(
      mem,
      [makeCandidate({ action: "retire", supersedes_id: "f-001", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.retired).toBe(1);
    const updated = memory.facts.find((f) => f.id === "f-001");
    expect(updated?.status).toBe("retired");
    expect(updated?.retired_reason).toBe("superseded");
  });

  test("unknown id → discarded", () => {
    const { result } = applyCandidates(
      makeMemory(),
      [makeCandidate({ action: "retire", supersedes_id: "f-ghost", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(result.discarded).toBe(1);
    expect(result.retired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// update action
// ---------------------------------------------------------------------------

describe("update action", () => {
  // NOTE: update path intentionally excluded from the pending-first flip
  // (update-generated replacement facts + approval-UI sequencing). Do not flip.
  test("valid id + confidence >= 0.9 → new fact appended (active), old retired (superseded)", () => {
    const fact = makeFact({ id: "f-001" });
    const mem = makeMemory([fact]);
    const { memory, result } = applyCandidates(
      mem,
      [
        makeCandidate({
          action: "update",
          candidate_claim: "Updated claim.",
          supersedes_id: "f-001",
          suggested_confidence: 0.95,
        }),
      ],
      NOW,
    );
    expect(result.updated).toBe(1);
    expect(result.discarded).toBe(0);
    // Old fact retired
    const old = memory.facts.find((f) => f.id === "f-001");
    expect(old?.status).toBe("retired");
    expect(old?.retired_reason).toBe("superseded");
    // New fact appended
    const newFact = memory.facts.find((f) => f.text === "Updated claim.");
    expect(newFact).toBeDefined();
    expect(newFact?.status).toBe("active");
    expect(newFact?.supersedes).toBe("f-001");
  });

  test("valid id + confidence 0.75 → new fact appended as pending", () => {
    const fact = makeFact({ id: "f-001" });
    const { memory, result } = applyCandidates(
      makeMemory([fact]),
      [
        makeCandidate({
          action: "update",
          candidate_claim: "Pending update.",
          supersedes_id: "f-001",
          suggested_confidence: 0.75,
        }),
      ],
      NOW,
    );
    expect(result.updated).toBe(1);
    const newFact = memory.facts.find((f) => f.text === "Pending update.");
    expect(newFact?.status).toBe("pending");
  });

  test("valid id + confidence < 0.7 → discarded, existing fact NOT retired (F2 data-loss guard)", () => {
    const fact = makeFact({ id: "f-001" });
    const { memory, result } = applyCandidates(
      makeMemory([fact]),
      [
        makeCandidate({
          action: "update",
          candidate_claim: "Low confidence update.",
          supersedes_id: "f-001",
          suggested_confidence: 0.5,
        }),
      ],
      NOW,
    );
    expect(result.discarded).toBe(1);
    expect(result.updated).toBe(0);
    // Existing fact must NOT be retired — a hallucinated low-conf update
    // must not silently evict a high-conf active fact.
    const old = memory.facts.find((f) => f.id === "f-001");
    expect(old?.status).toBe("active");
    expect(old?.retired_reason).toBeNull();
    // No new fact added
    expect(memory.facts.filter((f) => f.text === "Low confidence update.")).toHaveLength(0);
  });

  test("unknown id → discarded", () => {
    const { result } = applyCandidates(
      makeMemory(),
      [makeCandidate({ action: "update", supersedes_id: "f-ghost", suggested_confidence: 0.95 })],
      NOW,
    );
    expect(result.discarded).toBe(1);
    expect(result.updated).toBe(0);
  });

  test("sets superseded_by on the old fact pointing at the new fact (update)", () => {
    const old = makeFact({ id: "f-old" });
    const mem = makeMemory([old]);
    const { memory } = applyCandidates(
      mem,
      [makeCandidate({
        action: "update",
        supersedes_id: "f-old",
        candidate_claim: "uses bun",
        suggested_confidence: 0.95,
      })],
      NOW,
    );

    const retiredOld = memory.facts.find((f) => f.id === "f-old")!;
    const fresh = memory.facts.find((f) => f.id !== "f-old")!;
    expect(retiredOld.status).toBe("retired");
    expect(retiredOld.retired_reason).toBe("superseded");
    expect(retiredOld.superseded_by).toBe(fresh.id);
    expect(fresh.supersedes).toBe("f-old");
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("purity", () => {
  test("input memory is not mutated", () => {
    const fact = makeFact({ id: "f-001", last_seen_at: "2025-01-01T00:00:00Z" });
    const mem = makeMemory([fact]);
    const originalFacts = JSON.stringify(mem.facts);
    applyCandidates(
      mem,
      [makeCandidate({ action: "skip", supersedes_id: "f-001", suggested_confidence: 0.9 })],
      NOW,
    );
    expect(JSON.stringify(mem.facts)).toBe(originalFacts);
  });

  test("returned memory is a new object reference", () => {
    const mem = makeMemory();
    const { memory } = applyCandidates(mem, [], NOW);
    expect(memory).not.toBe(mem);
  });
});

// ---------------------------------------------------------------------------
// stability code floor + expires_at carry-through
// ---------------------------------------------------------------------------

describe("stability code floor", () => {
  test("add: candidate with no stability → stored fact 'durable'", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ action: "add", suggested_confidence: 0.95 })],
      NOW,
    );
    const added = memory.facts.at(-1)!;
    expect(added.stability).toBe("durable");
  });

  test("add: candidate stability='permanent' → stored fact 'permanent'", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ action: "add", stability: "permanent", suggested_confidence: 0.95 })],
      NOW,
    );
    const added = memory.facts.at(-1)!;
    expect(added.stability).toBe("permanent");
  });

  test("update: candidate stability='permanent' → new fact 'permanent'", () => {
    const old = makeFact({ id: "f-old" });
    const { memory } = applyCandidates(
      makeMemory([old]),
      [makeCandidate({
        action: "update",
        supersedes_id: "f-old",
        candidate_claim: "new claim",
        stability: "permanent",
        suggested_confidence: 0.95,
      })],
      NOW,
    );
    const fresh = memory.facts.find((f) => f.id !== "f-old")!;
    expect(fresh.stability).toBe("permanent");
  });

  test("add: candidate time-bound with expires_at → fact carries expires_at", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({
        action: "add",
        stability: "time-bound",
        expires_at: "2026-09-01T00:00:00Z",
        suggested_confidence: 0.95,
      })],
      NOW,
    );
    const added = memory.facts.at(-1)!;
    expect(added.stability).toBe("time-bound");
    expect(added.expires_at).toBe("2026-09-01T00:00:00Z");
  });

  test("add: candidate without expires_at → fact expires_at null", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ action: "add", suggested_confidence: 0.95 })],
      NOW,
    );
    const added = memory.facts.at(-1)!;
    expect(added.expires_at).toBeNull();
  });

  test("update: candidate time-bound with expires_at → new fact carries expires_at", () => {
    const old = makeFact({ id: "f-old" });
    const { memory } = applyCandidates(
      makeMemory([old]),
      [makeCandidate({
        action: "update",
        supersedes_id: "f-old",
        candidate_claim: "new claim",
        stability: "time-bound",
        expires_at: "2026-09-01T00:00:00Z",
        suggested_confidence: 0.95,
      })],
      NOW,
    );
    const fresh = memory.facts.find((f) => f.id !== "f-old")!;
    expect(fresh.expires_at).toBe("2026-09-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// save_reason (Memory Book)
// ---------------------------------------------------------------------------

describe("save_reason (Memory Book)", () => {
  test("carries why_worth_saving onto the new fact as save_reason (add)", () => {
    const { memory } = applyCandidates(makeMemory(), [makeCandidate({
      why_worth_saving: "recurs across sessions",
      action: "add", candidate_claim: "prefers TDD", evidence_quote: null,
      suggested_confidence: 0.95, supersedes_id: null,
    })], new Date("2026-06-25T00:00:00.000Z"));
    expect(memory.facts.at(-1)?.save_reason).toBe("recurs across sessions");
  });

  test("PII path in why_worth_saving → save_reason null (drop, not redact)", () => {
    const longPath = "saved because file /Users/alice/secret/app.ts kept breaking";
    const { memory } = applyCandidates(makeMemory(), [makeCandidate({
      why_worth_saving: longPath,
      action: "add", candidate_claim: "x", evidence_quote: null,
      suggested_confidence: 0.95, supersedes_id: null,
    })], new Date("2026-06-25T00:00:00.000Z"));
    expect(memory.facts.at(-1)?.save_reason).toBeNull();
  });

  test("leaves save_reason null when candidate omits why (legacy)", () => {
    const { memory } = applyCandidates(makeMemory(), [makeCandidate({
      action: "add", candidate_claim: "y", evidence_quote: null,
      suggested_confidence: 0.95, supersedes_id: null,
    })], new Date("2026-06-25T00:00:00.000Z"));
    expect(memory.facts.at(-1)?.save_reason).toBeNull();
  });

  test("update with why_worth_saving → new fact carries save_reason", () => {
    const old = makeFact({ id: "f-old", save_reason: "original reason" });
    const { memory } = applyCandidates(makeMemory([old]), [makeCandidate({
      action: "update", supersedes_id: "f-old",
      candidate_claim: "updated claim",
      why_worth_saving: "fresh reason for update",
      suggested_confidence: 0.95,
    })], new Date("2026-06-25T00:00:00.000Z"));
    const newFact = memory.facts.find((f) => f.text === "updated claim");
    expect(newFact?.save_reason).toBe("fresh reason for update");
  });

  test("update without why_worth_saving → new fact inherits prior save_reason", () => {
    const old = makeFact({ id: "f-old", save_reason: "prior reason" });
    const { memory } = applyCandidates(makeMemory([old]), [makeCandidate({
      action: "update", supersedes_id: "f-old",
      candidate_claim: "updated claim",
      suggested_confidence: 0.95,
    })], new Date("2026-06-25T00:00:00.000Z"));
    const newFact = memory.facts.find((f) => f.text === "updated claim");
    expect(newFact?.save_reason).toBe("prior reason");
  });

  test("update with PII why_worth_saving → save_reason drops to null, NOT prior reason", () => {
    // Bug scenario: candidate provides a fresh why containing a home-path (PII).
    // saveReasonFrom() returns null (intentional drop). The prior ?? fallback must
    // NOT resurrect the old reason — the correct result is null.
    const old = makeFact({ id: "f-old", save_reason: "prior non-null reason" });
    const { memory } = applyCandidates(makeMemory([old]), [makeCandidate({
      action: "update", supersedes_id: "f-old",
      candidate_claim: "updated claim",
      why_worth_saving: "/Users/alice/secret.ts keeps causing issues",
      suggested_confidence: 0.95,
    })], new Date("2026-06-25T00:00:00.000Z"));
    const newFact = memory.facts.find((f) => f.text === "updated claim");
    // PII why must drop to null — must NOT fall back to "prior non-null reason"
    expect(newFact?.save_reason).toBeNull();
  });

  test("caps save_reason at 280 chars", () => {
    const longWhy = "a".repeat(400);
    const { memory } = applyCandidates(makeMemory(), [makeCandidate({
      why_worth_saving: longWhy,
      action: "add", candidate_claim: "z", evidence_quote: null,
      suggested_confidence: 0.95, supersedes_id: null,
    })], new Date("2026-06-25T00:00:00.000Z"));
    expect(memory.facts.at(-1)?.save_reason).toHaveLength(280);
  });

  test("300-char why_worth_saving (just over display cap) → save_reason sliced to 280, fact NOT dropped", () => {
    // Verifies that a why_worth_saving exceeding the former 280-char schema max
    // does NOT silently discard the fact — apply-time slice still caps the stored
    // save_reason at 280, but the fact itself must survive.
    const why300 = "b".repeat(300);
    const { memory, result } = applyCandidates(makeMemory(), [makeCandidate({
      why_worth_saving: why300,
      action: "add", candidate_claim: "fact that must not be dropped", evidence_quote: null,
      suggested_confidence: 0.95, supersedes_id: null,
    })], new Date("2026-06-25T00:00:00.000Z"));
    expect(result.added).toBe(1);
    expect(memory.facts.at(-1)?.save_reason).toHaveLength(280);
  });
});

// ---------------------------------------------------------------------------
// Mixed candidates
// ---------------------------------------------------------------------------

describe("mixed candidates", () => {
  test("mix of 5 candidates → result counts correct", () => {
    const f1 = makeFact({ id: "f-001" });
    const f2 = makeFact({ id: "f-002", text: "Another fact." });
    const f3 = makeFact({ id: "f-003", text: "Third fact." });
    const mem = makeMemory([f1, f2, f3]);

    const candidates: Candidate[] = [
      // add high confidence → added
      makeCandidate({ action: "add", suggested_confidence: 0.95 }),
      // add low confidence → discarded
      makeCandidate({ action: "add", candidate_claim: "Low conf.", suggested_confidence: 0.5 }),
      // skip valid → skipped
      makeCandidate({ action: "skip", supersedes_id: "f-001", suggested_confidence: 0.9 }),
      // retire valid → retired
      makeCandidate({ action: "retire", supersedes_id: "f-002", suggested_confidence: 0.9 }),
      // update valid → updated
      makeCandidate({
        action: "update",
        candidate_claim: "Updated f3.",
        supersedes_id: "f-003",
        suggested_confidence: 0.95,
      }),
    ];

    const { result } = applyCandidates(mem, candidates, NOW);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.retired).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.discarded).toBe(1);
  });
});
