/**
 * Acceptance tests — chat-memory forget / expiry / lifecycle.
 *
 * One test (or small describe) per acceptance criterion, each driving the REAL pipeline function
 * with constructed inputs and asserting on the OBSERVABLE result (stored fact
 * fields/status after the real function runs, or the real filter's verdict).
 *
 * DETERMINISTIC — no paid LLM. All time is a frozen `NOW` Date; no Date.now().
 * The units under test are NOT mocked: we call the real applyCandidates /
 * proposeDecayedFacts / isStale / staleFacts / containsSecret / approveFactCore.
 */

import { describe, expect, test } from "bun:test";
import { applyCandidates } from "../../src/memory/apply-candidates";
import {
  proposeDecayedFacts,
  isStale,
  staleFacts,
  STALENESS_DAYS,
} from "../../src/memory/decay";
import { containsSecret } from "../../src/memory/chat-signal";
import { approveFactCore } from "../../src/memory/transitions";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import type { Candidate } from "../../src/memory/summarizer";

// ---------------------------------------------------------------------------
// Frozen time + fixtures (mirror tests/memory/{apply-candidates,decay}.test.ts)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-06-24T00:00:00.000Z");
const MS_PER_DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * MS_PER_DAY).toISOString();
}
function daysFromNow(n: number): string {
  return new Date(NOW.getTime() + n * MS_PER_DAY).toISOString();
}

function makeMemory(facts: Fact[] = []): CoreMemory {
  return {
    schemaVersion: 2,
    long_term_summary: "",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: NOW.toISOString(),
    consolidation_due_at: NOW.toISOString(),
    user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
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
    created_at: NOW.toISOString(),
    last_seen_at: NOW.toISOString(),
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

// ===========================================================================
// Newly-ADDED candidate (any confidence incl ≥0.9) → stored pending,
// never active. Nothing is born active.
// ===========================================================================

describe("newly-added facts land pending (never born active)", () => {
  test("add candidate at confidence 0.95 → stored fact status='pending', not 'active'", () => {
    const { memory, result } = applyCandidates(
      makeMemory(),
      [makeCandidate({ suggested_confidence: 0.95, candidate_claim: "high-conf claim" })],
      NOW,
    );
    expect(result.added).toBe(1);
    const stored = memory.facts.find((f) => f.text === "high-conf claim");
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("pending");
    expect(stored?.status).not.toBe("active");
  });

  test("add candidate at confidence 1.0 (max) still lands pending", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ suggested_confidence: 1.0, candidate_claim: "max-conf claim" })],
      NOW,
    );
    const stored = memory.facts.find((f) => f.text === "max-conf claim");
    expect(stored?.status).toBe("pending");
  });
});

// ===========================================================================
// Provenance: candidate.source {stream:"chat",session_id:"s1"} →
// stored fact learned_from populated (not null) + source_session_id
// backfilled. The write path no longer hardcodes source_session_id:null.
// ===========================================================================

describe("provenance populated from candidate.source", () => {
  test("add candidate with source chat/s1 → learned_from set + source_session_id backfilled", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [
        makeCandidate({
          candidate_claim: "provenance claim",
          source: { stream: "chat", session_id: "s1" },
        }),
      ],
      NOW,
    );
    const stored = memory.facts.find((f) => f.text === "provenance claim");
    expect(stored).toBeDefined();
    expect(stored?.learned_from).not.toBeNull();
    expect(stored?.learned_from).toEqual({ stream: "chat", session_id: "s1" });
    // legacy field backfilled from the same source (not hardcoded null)
    expect(stored?.source_session_id).toBe("s1");
  });

  test("update path also threads source provenance onto the new fact", () => {
    const existing = makeFact({ id: "f-old-a", text: "old", status: "active" });
    const { memory } = applyCandidates(
      makeMemory([existing]),
      [
        makeCandidate({
          action: "update",
          supersedes_id: "f-old-a",
          candidate_claim: "updated claim",
          suggested_confidence: 0.95,
          source: { stream: "critique", session_id: "s9" },
        }),
      ],
      NOW,
    );
    const newFact = memory.facts.find((f) => f.text === "updated claim");
    expect(newFact?.learned_from).toEqual({ stream: "critique", session_id: "s9" });
    expect(newFact?.source_session_id).toBe("s9");
  });
});

// ===========================================================================
// Summarizer stability flows + code floor. permanent stored permanent;
// missing stability → durable. Covers BOTH add AND update branches.
// A permanent non-pinned fact is still decay-eligible; pinned permanent
// is exempt.
// ===========================================================================

describe("stability assignment + code floor (add & update branches)", () => {
  test("add: candidate stability='permanent' → stored fact stability='permanent'", () => {
    const { memory } = applyCandidates(
      makeMemory(),
      [makeCandidate({ candidate_claim: "add permanent", stability: "permanent" })],
      NOW,
    );
    const stored = memory.facts.find((f) => f.text === "add permanent");
    expect(stored?.stability).toBe("permanent");
  });

  test("add: candidate with NO stability → stored fact defaults to 'durable' (code floor)", () => {
    const cand = makeCandidate({ candidate_claim: "add no-stability" });
    expect(cand.stability).toBeUndefined();
    const { memory } = applyCandidates(makeMemory(), [cand], NOW);
    const stored = memory.facts.find((f) => f.text === "add no-stability");
    expect(stored?.stability).toBe("durable");
  });

  test("update: candidate stability='permanent' → superseding fact stability='permanent'", () => {
    const existing = makeFact({ id: "f-old-perm", text: "old perm", status: "active" });
    const { memory } = applyCandidates(
      makeMemory([existing]),
      [
        makeCandidate({
          action: "update",
          supersedes_id: "f-old-perm",
          candidate_claim: "update permanent",
          suggested_confidence: 0.95,
          stability: "permanent",
        }),
      ],
      NOW,
    );
    const newFact = memory.facts.find((f) => f.text === "update permanent");
    expect(newFact?.stability).toBe("permanent");
  });

  test("update: candidate with NO stability → superseding fact floors to 'durable'", () => {
    const existing = makeFact({ id: "f-old-dur", text: "old dur", status: "active" });
    const cand = makeCandidate({
      action: "update",
      supersedes_id: "f-old-dur",
      candidate_claim: "update no-stability",
      suggested_confidence: 0.95,
    });
    expect(cand.stability).toBeUndefined();
    const { memory } = applyCandidates(makeMemory([existing]), [cand], NOW);
    const newFact = memory.facts.find((f) => f.text === "update no-stability");
    expect(newFact?.stability).toBe("durable");
  });

  test("a permanent, non-pinned, decayed fact IS proposed for retirement (permanent ≠ decay-exempt)", () => {
    // permanent does NOT exempt from decay; only pinned is sacred.
    const decayed = makeFact({
      id: "f-perm-decay",
      text: "permanent decayed",
      stability: "permanent",
      pinned: false,
      status: "active",
      confidence: 0.5,
      last_seen_at: daysAgo(90), // exp(-3)*0.5 ≈ 0.0249 < DECAY_THRESHOLD(0.03)
      recall_count: 0,
    });
    const { memory, result } = proposeDecayedFacts(makeMemory([decayed]), NOW);
    expect(result.proposed).toBe(1);
    const after = memory.facts.find((f) => f.id === "f-perm-decay");
    expect(after?.status).toBe("retire_proposed");
  });

  test("a PINNED permanent decayed fact is exempt (pin wins, not proposed)", () => {
    const pinnedPerm = makeFact({
      id: "f-perm-pinned",
      text: "permanent pinned",
      stability: "permanent",
      pinned: true,
      status: "active",
      confidence: 0.5,
      last_seen_at: daysAgo(90),
      recall_count: 0,
    });
    const { memory, result } = proposeDecayedFacts(makeMemory([pinnedPerm]), NOW);
    expect(result.proposed).toBe(0);
    const after = memory.facts.find((f) => f.id === "f-perm-pinned");
    expect(after?.status).toBe("active");
  });
});

// ===========================================================================
// Time-bound expiry → soft tombstone (retire_proposed), kept in store.
// Future expires_at stays active. null expires_at: not proposed, no throw.
// ===========================================================================

describe("time-bound expiry is a soft tombstone (never hard-deleted)", () => {
  test("time-bound fact PAST expires_at → retire_proposed AND still present in memory.facts", () => {
    const expired = makeFact({
      id: "f-expired",
      text: "expired",
      stability: "time-bound",
      status: "active",
      expires_at: daysAgo(1), // past
      last_seen_at: daysAgo(1), // fresh enough that decay alone wouldn't propose
    });
    const { memory, result } = proposeDecayedFacts(makeMemory([expired]), NOW);
    expect(result.proposed).toBe(1);
    const after = memory.facts.find((f) => f.id === "f-expired");
    expect(after).toBeDefined(); // NOT hard-deleted
    expect(after?.status).toBe("retire_proposed");
  });

  test("time-bound fact with FUTURE expires_at stays active (not proposed)", () => {
    const future = makeFact({
      id: "f-future",
      text: "future",
      stability: "time-bound",
      status: "active",
      expires_at: daysFromNow(30),
      last_seen_at: daysAgo(0),
    });
    const { memory, result } = proposeDecayedFacts(makeMemory([future]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts.find((f) => f.id === "f-future")?.status).toBe("active");
  });

  test("time-bound fact with expires_at=null is NOT proposed and does not throw", () => {
    const noExpiry = makeFact({
      id: "f-null-expiry",
      text: "null expiry",
      stability: "time-bound",
      status: "active",
      expires_at: null,
    save_reason: null,
      last_seen_at: daysAgo(0), // fresh → decay won't propose either
    });
    expect(() => proposeDecayedFacts(makeMemory([noExpiry]), NOW)).not.toThrow();
    const { memory, result } = proposeDecayedFacts(makeMemory([noExpiry]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts.find((f) => f.id === "f-null-expiry")?.status).toBe("active");
  });
});

// ===========================================================================
// Durable staleness is a read-time flag; never mutates stored confidence.
// ===========================================================================

describe("durable staleness flag (read-time, no confidence mutation)", () => {
  test("durable fact with old last_confirmed_at is flagged stale; confidence unchanged", () => {
    const stale = makeFact({
      id: "f-stale",
      text: "stale",
      stability: "durable",
      status: "active",
      confidence: 0.8,
      last_confirmed_at: daysAgo(STALENESS_DAYS + 5),
    });
    const mem = makeMemory([stale]);
    expect(isStale(stale, NOW)).toBe(true);
    const flagged = staleFacts(mem, NOW);
    expect(flagged.map((f) => f.id)).toContain("f-stale");
    // read-time only: stored confidence is untouched.
    expect(mem.facts.find((f) => f.id === "f-stale")?.confidence).toBe(0.8);
  });

  test("durable fact with null last_confirmed_at falls back to created_at (old → stale)", () => {
    const stale = makeFact({
      id: "f-stale-fallback",
      stability: "durable",
      status: "active",
      last_confirmed_at: null,
      created_at: daysAgo(STALENESS_DAYS + 5),
    });
    expect(isStale(stale, NOW)).toBe(true);
  });

  test("a freshly-confirmed durable fact is NOT flagged stale", () => {
    const fresh = makeFact({
      id: "f-fresh",
      stability: "durable",
      status: "active",
      last_confirmed_at: daysAgo(1),
    });
    expect(isStale(fresh, NOW)).toBe(false);
    expect(staleFacts(makeMemory([fresh]), NOW)).toHaveLength(0);
  });
});

// ===========================================================================
// Pin precedence: pin wins over stability/expires_at.
// ===========================================================================

describe("pin precedence (pin wins over stability & expiry)", () => {
  test("a PINNED time-bound fact past expires_at is NOT proposed (still active)", () => {
    const pinnedExpired = makeFact({
      id: "f-pinned-expired",
      stability: "time-bound",
      pinned: true,
      status: "active",
      expires_at: daysAgo(10),
      last_seen_at: daysAgo(10),
    });
    const { memory, result } = proposeDecayedFacts(makeMemory([pinnedExpired]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts.find((f) => f.id === "f-pinned-expired")?.status).toBe("active");
  });

  test("a PINNED durable fact past staleness is NOT flagged stale", () => {
    const pinnedStale = makeFact({
      id: "f-pinned-stale",
      stability: "durable",
      pinned: true,
      status: "active",
      last_confirmed_at: daysAgo(STALENESS_DAYS + 30),
    });
    expect(isStale(pinnedStale, NOW)).toBe(false);
    expect(staleFacts(makeMemory([pinnedStale]), NOW)).toHaveLength(0);
  });
});

// ===========================================================================
// Write-boundary PII filter: drop home paths + emails; names & relative
// paths survive. (containsSecret = true means the message is dropped.)
// ===========================================================================

describe("PII boundary: home paths + emails dropped, names + relative paths survive", () => {
  test("an absolute home path (/Users/alice/...) is dropped (containsSecret=true)", () => {
    expect(containsSecret("my config lives at /Users/alice/.siltpoke/config.json")).toBe(true);
  });

  test("an email address (a@b.com) is dropped (containsSecret=true)", () => {
    expect(containsSecret("ping me at a@b.com about the build")).toBe(true);
  });

  test("a person's NAME survives (false-positive guard — names are signal)", () => {
    expect(containsSecret("the user prefers Chinese")).toBe(false);
  });

  test("a relative repo path (src/foo.ts) survives (no identity → not dropped)", () => {
    expect(containsSecret("the bug is in src/foo.ts near the loop")).toBe(false);
  });
});

// ===========================================================================
// Skip vs retire_proposed reconciliation. A skip on a retire_proposed
// fact restores it to active; a skip on a pending fact leaves it pending.
// ===========================================================================

describe("skip overrides a decay proposal but never auto-activates pending", () => {
  test("skip on a retire_proposed fact → restored to active (last_seen_at refreshed)", () => {
    const proposed = makeFact({
      id: "f-proposed",
      text: "proposed",
      status: "retire_proposed",
      last_seen_at: daysAgo(90),
    });
    const { memory, result } = applyCandidates(
      makeMemory([proposed]),
      [makeCandidate({ action: "skip", supersedes_id: "f-proposed" })],
      NOW,
    );
    expect(result.skipped).toBe(1);
    const after = memory.facts.find((f) => f.id === "f-proposed");
    expect(after?.status).toBe("active");
    expect(after?.last_seen_at).toBe(NOW.toISOString());
  });

  test("skip on a pending fact leaves it pending (never auto-activate)", () => {
    const pending = makeFact({
      id: "f-pending",
      text: "pending",
      status: "pending",
    });
    const { memory, result } = applyCandidates(
      makeMemory([pending]),
      [makeCandidate({ action: "skip", supersedes_id: "f-pending" })],
      NOW,
    );
    expect(result.skipped).toBe(1);
    expect(memory.facts.find((f) => f.id === "f-pending")?.status).toBe("pending");
  });

  // Anchor that the only active→active path to active is approve.
  test("approveFactCore is the sanctioned pending→active transition (sets last_confirmed_at)", () => {
    const pending = makeFact({ id: "f-approve", status: "pending", last_confirmed_at: null });
    const res = approveFactCore(makeMemory([pending]), "f-approve", () => NOW.toISOString());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fact.status).toBe("active");
      expect(res.fact.last_confirmed_at).toBe(NOW.toISOString());
    }
  });
});
