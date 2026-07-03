import { describe, expect, it } from "bun:test";
import {
  decayScore,
  DECAY_THRESHOLD,
  proposeDecayedFacts,
  isExpired,
  isStale,
  staleFacts,
  STALENESS_DAYS,
} from "../../src/memory/decay";
import type { CoreMemory, Fact } from "../../src/memory/memory";

const NOW = new Date("2026-06-24T00:00:00.000Z");

function fact(over: Partial<Fact>): Fact {
  return {
    id: "f-1",
    text: "x",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-24T00:00:00.000Z",
    last_seen_at: "2026-06-24T00:00:00.000Z",
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
    ...over,
  };
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function mem(facts: Fact[]): CoreMemory {
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

describe("decayScore", () => {
  it("a fresh fact scores ≈ its confidence (recency≈1, recall factor 1)", () => {
    const s = decayScore(fact({ confidence: 0.9, last_seen_at: daysAgo(0) }), NOW);
    expect(s).toBeCloseTo(0.9, 5);
  });

  it("decreases as the fact ages (recency decay)", () => {
    const fresh = decayScore(fact({ last_seen_at: daysAgo(0) }), NOW);
    const old = decayScore(fact({ last_seen_at: daysAgo(60) }), NOW);
    expect(old).toBeLessThan(fresh);
  });

  it("increases with confidence", () => {
    const lo = decayScore(fact({ confidence: 0.3, last_seen_at: daysAgo(10) }), NOW);
    const hi = decayScore(fact({ confidence: 0.9, last_seen_at: daysAgo(10) }), NOW);
    expect(hi).toBeGreaterThan(lo);
  });

  it("increases with recall_count (a recalled fact resists decay)", () => {
    const cold = decayScore(fact({ recall_count: 0, last_seen_at: daysAgo(40) }), NOW);
    const warm = decayScore(fact({ recall_count: 5, last_seen_at: daysAgo(40) }), NOW);
    expect(warm).toBeGreaterThan(cold);
  });

  it("an old low-confidence fact falls below the decay threshold", () => {
    const s = decayScore(fact({ confidence: 0.5, last_seen_at: daysAgo(90), recall_count: 0 }), NOW);
    expect(s).toBeLessThan(DECAY_THRESHOLD);
  });

  it("a future last_seen_at clamps age to 0 (no score blow-up)", () => {
    const s = decayScore(fact({ confidence: 0.8, last_seen_at: daysAgo(-5) }), NOW);
    expect(s).toBeCloseTo(0.8, 5);
  });
});

describe("proposeDecayedFacts", () => {
  it("proposes a stale active fact for retirement", () => {
    const stale = fact({ id: "f-stale", confidence: 0.5, last_seen_at: daysAgo(90) });
    const { memory, result } = proposeDecayedFacts(mem([stale]), NOW);
    expect(result.proposed).toBe(1);
    expect(memory.facts[0]!.status).toBe("retire_proposed");
  });

  it("leaves a fresh active fact active", () => {
    const fresh = fact({ id: "f-fresh", confidence: 0.9, last_seen_at: daysAgo(1) });
    const { memory, result } = proposeDecayedFacts(mem([fresh]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });

  it("never proposes a pinned fact, however stale", () => {
    const pinned = fact({ id: "f-pin", confidence: 0.4, last_seen_at: daysAgo(365), pinned: true });
    const { memory, result } = proposeDecayedFacts(mem([pinned]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });

  it("ignores pending and retired facts", () => {
    const pending = fact({ id: "f-pend", status: "pending", last_seen_at: daysAgo(200) });
    const retired = fact({ id: "f-ret", status: "retired", last_seen_at: daysAgo(200) });
    const { result } = proposeDecayedFacts(mem([pending, retired]), NOW);
    expect(result.proposed).toBe(0);
  });


  it("a high-confidence fact at 90d is NOT proposed (score ~0.0473 > 0.03 threshold)", () => {
    // conf-0.95 at 90d: exp(-90/30) * 0.95 * 1 = exp(-3) * 0.95 approx 0.0473 > DECAY_THRESHOLD (0.03)
    const highConf = fact({ id: "f-high", confidence: 0.95, last_seen_at: daysAgo(90) });
    const { memory, result } = proposeDecayedFacts(mem([highConf]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });

  it("a stale 'permanent' but NON-pinned fact IS still proposed (only pinned is sacred)", () => {
    // Code-floor invariant: an LLM-proposed `permanent` stability does NOT
    // grant decay-exemption. Decay keys exemption on `pinned` only. A permanent
    // fact that has gone stale and is unpinned must still be proposed.
    const stalePermanent = fact({
      id: "f-perm",
      stability: "permanent",
      pinned: false,
      confidence: 0.5,
      last_seen_at: daysAgo(90),
    });
    const { memory, result } = proposeDecayedFacts(mem([stalePermanent]), NOW);
    expect(result.proposed).toBe(1);
    expect(memory.facts[0]!.status).toBe("retire_proposed");
  });

  it("a stale 'permanent' AND pinned fact is exempt (pin wins)", () => {
    const stalePinnedPermanent = fact({
      id: "f-perm-pin",
      stability: "permanent",
      pinned: true,
      confidence: 0.5,
      last_seen_at: daysAgo(90),
    });
    const { memory, result } = proposeDecayedFacts(mem([stalePinnedPermanent]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });

  it("does not mutate the input memory", () => {
    const stale = fact({ id: "f-stale", confidence: 0.5, last_seen_at: daysAgo(90) });
    const input = mem([stale]);
    proposeDecayedFacts(input, NOW);
    expect(input.facts[0]!.status).toBe("active");
  });

  // ---- Time-bound expiry → soft tombstone ---------------------------------

  it("expiry: a time-bound fact past expires_at is proposed for retirement (soft tombstone, still in store)", () => {
    const expired = fact({
      id: "f-exp",
      stability: "time-bound",
      expires_at: daysAgo(1), // expired yesterday
      confidence: 0.95,
      last_seen_at: daysAgo(0), // fresh by decay — only expiry should retire it
    });
    const { memory, result } = proposeDecayedFacts(mem([expired]), NOW);
    expect(result.proposed).toBe(1);
    expect(memory.facts[0]!.status).toBe("retire_proposed");
    // soft tombstone: still present in the store, not hard-deleted
    expect(memory.facts).toHaveLength(1);
    expect(memory.facts[0]!.id).toBe("f-exp");
  });

  it("expiry: a time-bound fact whose expires_at is in the FUTURE still surfaces (stays active)", () => {
    const future = fact({
      id: "f-future",
      stability: "time-bound",
      expires_at: daysAgo(-30), // expires 30d from now
      confidence: 0.95,
      last_seen_at: daysAgo(0),
    });
    const { memory, result } = proposeDecayedFacts(mem([future]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });

  it("edge: a time-bound fact with expires_at:null cannot expire (no crash, stays active)", () => {
    const noDate = fact({
      id: "f-nodate",
      stability: "time-bound",
      expires_at: null,
        save_reason: null,
      confidence: 0.95,
      last_seen_at: daysAgo(0),
    });
    expect(isExpired(noDate, NOW)).toBe(false);
    const { memory, result } = proposeDecayedFacts(mem([noDate]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });

  it("pin precedence: a pinned time-bound fact past expires_at STILL surfaces (pin wins)", () => {
    const pinnedExpired = fact({
      id: "f-pin-exp",
      stability: "time-bound",
      expires_at: daysAgo(10),
      pinned: true,
      confidence: 0.95,
      last_seen_at: daysAgo(0),
    });
    const { memory, result } = proposeDecayedFacts(mem([pinnedExpired]), NOW);
    expect(result.proposed).toBe(0);
    expect(memory.facts[0]!.status).toBe("active");
  });
});

describe("staleness (isStale / staleFacts)", () => {
  it("STALENESS_DAYS default is 60", () => {
    expect(STALENESS_DAYS).toBe(60);
  });

  // ---- Durable staleness → flag for reconfirmation ------------------------

  it("staleness: a durable fact confirmed > STALENESS_DAYS ago is flagged stale; stored confidence unchanged", () => {
    const old = fact({
      id: "f-stale-dur",
      stability: "durable",
      last_confirmed_at: daysAgo(61),
      confidence: 0.8,
    });
    expect(isStale(old, NOW)).toBe(true);
    // read-time only: stored confidence is untouched by the check
    expect(old.confidence).toBe(0.8);
    const listed = staleFacts(mem([old]), NOW);
    expect(listed.map((f) => f.id)).toEqual(["f-stale-dur"]);
    // staleFacts must not mutate stored confidence either
    expect(listed[0]!.confidence).toBe(0.8);
  });

  it("staleness: a durable fact confirmed within STALENESS_DAYS is NOT flagged", () => {
    const fresh = fact({
      id: "f-fresh-dur",
      stability: "durable",
      last_confirmed_at: daysAgo(10),
    });
    expect(isStale(fresh, NOW)).toBe(false);
    expect(staleFacts(mem([fresh]), NOW)).toHaveLength(0);
  });

  it("staleness fallback: last_confirmed_at null falls back to created_at (old created_at → stale)", () => {
    const neverConfirmed = fact({
      id: "f-nullconf",
      stability: "durable",
      last_confirmed_at: null,
      created_at: daysAgo(90),
    });
    expect(isStale(neverConfirmed, NOW)).toBe(true);
  });

  it("staleness fallback: null last_confirmed_at + recent created_at → NOT stale", () => {
    const recent = fact({
      id: "f-nullfresh",
      stability: "durable",
      last_confirmed_at: null,
      created_at: daysAgo(5),
    });
    expect(isStale(recent, NOW)).toBe(false);
  });

  it("staleness: non-durable facts are never flagged stale (only durable demotes)", () => {
    const oldTimeBound = fact({
      id: "f-tb",
      stability: "time-bound",
      last_confirmed_at: daysAgo(365),
    });
    const oldPermanent = fact({
      id: "f-perm",
      stability: "permanent",
      last_confirmed_at: daysAgo(365),
    });
    expect(isStale(oldTimeBound, NOW)).toBe(false);
    expect(isStale(oldPermanent, NOW)).toBe(false);
  });

  it("pin precedence: a pinned durable fact past staleness is NOT flagged stale (pin wins)", () => {
    const pinnedStale = fact({
      id: "f-pin-stale",
      stability: "durable",
      pinned: true,
      last_confirmed_at: daysAgo(365),
    });
    expect(isStale(pinnedStale, NOW)).toBe(false);
    expect(staleFacts(mem([pinnedStale]), NOW)).toHaveLength(0);
  });

  it("staleness: staleFacts only lists active facts (a stale pending fact is not surfaced)", () => {
    const stalePending = fact({
      id: "f-stale-pend",
      stability: "durable",
      status: "pending",
      last_confirmed_at: daysAgo(90),
    });
    expect(staleFacts(mem([stalePending]), NOW)).toHaveLength(0);
  });
});
