import { describe, expect, test } from "bun:test";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import {
  addFactCore,
  approveFactCore,
  confirmRetireFactCore,
  keepFactCore,
  reactivateFactCore,
  restateFactCore,
  retireFactCore,
  setFactPinnedCore,
  type TransitionResult,
} from "../../src/memory/transitions";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FROZEN_NOW = "2026-05-18T12:00:00.000Z";
const now = () => FROZEN_NOW;

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-aaaaaaaa",
    text: "user prefers terse responses",
    source_session_id: "s-bbbbbbbb",
    confidence: 0.8,
    status: "pending",
    created_at: "2026-05-15T00:00:00.000Z",
    last_seen_at: "2026-05-15T00:00:00.000Z",
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

function makeMemory(facts: Fact[]): CoreMemory {
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
    last_consolidated_at: "2026-05-14T00:00:00.000Z",
    consolidation_due_at: "2026-05-21T00:00:00.000Z",
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

function assertOk(
  result: TransitionResult,
): asserts result is { ok: true; memory: CoreMemory; fact: Fact } {
  if (!result.ok) {
    throw new Error(
      `expected ok result but got error: ${JSON.stringify(result.error)}`,
    );
  }
}

function assertErr(
  result: TransitionResult,
): asserts result is { ok: false; error: NonNullable<unknown> } & {
  ok: false;
  error: Extract<TransitionResult, { ok: false }>["error"];
} {
  if (result.ok) {
    throw new Error("expected error result but got ok");
  }
}

// ---------------------------------------------------------------------------
// approveFactCore
// ---------------------------------------------------------------------------

describe("approveFactCore", () => {
  test("happy: pending → active, last_seen_at bumped, other fields untouched", () => {
    const pending = makeFact({
      id: "f-111",
      status: "pending",
      text: "loves bun",
      confidence: 0.7,
      source_session_id: "s-xyz",
      created_at: "2026-05-15T00:00:00.000Z",
      last_seen_at: "2026-05-15T00:00:00.000Z",
      supersedes: null,
      retired_reason: null,
    });
    const memory = makeMemory([pending]);

    const result = approveFactCore(memory, "f-111", now);
    assertOk(result);

    expect(result.fact.id).toBe("f-111");
    expect(result.fact.status).toBe("active");
    expect(result.fact.last_seen_at).toBe(FROZEN_NOW);
    // other fields untouched
    expect(result.fact.text).toBe("loves bun");
    expect(result.fact.confidence).toBe(0.7);
    expect(result.fact.source_session_id).toBe("s-xyz");
    expect(result.fact.created_at).toBe("2026-05-15T00:00:00.000Z");
    expect(result.fact.supersedes).toBeNull();
    expect(result.fact.retired_reason).toBeNull();

    // memory.facts contains the updated fact at the same index
    expect(result.memory.facts).toHaveLength(1);
    expect(result.memory.facts[0]?.status).toBe("active");
    expect(result.memory.facts[0]?.last_seen_at).toBe(FROZEN_NOW);
  });

  test("approving a fact sets last_confirmed_at = now (reconfirmation anchor)", () => {
    const pending = makeFact({
      id: "f-confirm",
      status: "pending",
      last_confirmed_at: null,
    });
    const memory = makeMemory([pending]);

    const result = approveFactCore(memory, "f-confirm", now);
    assertOk(result);

    expect(result.fact.last_confirmed_at).toBe(FROZEN_NOW);
    expect(result.memory.facts[0]?.last_confirmed_at).toBe(FROZEN_NOW);
  });

  test("happy: preserves siblings in facts array", () => {
    const a = makeFact({ id: "f-aaa", status: "active" });
    const target = makeFact({ id: "f-bbb", status: "pending" });
    const c = makeFact({ id: "f-ccc", status: "retired", retired_reason: "superseded" });
    const memory = makeMemory([a, target, c]);

    const result = approveFactCore(memory, "f-bbb", now);
    assertOk(result);

    expect(result.memory.facts).toHaveLength(3);
    // siblings unchanged (same reference)
    expect(result.memory.facts[0]).toBe(a);
    expect(result.memory.facts[2]).toBe(c);
    // target updated
    expect(result.memory.facts[1]?.id).toBe("f-bbb");
    expect(result.memory.facts[1]?.status).toBe("active");
  });

  test("error: not_found when id absent", () => {
    const memory = makeMemory([makeFact({ id: "f-real" })]);
    const result = approveFactCore(memory, "f-ghost", now);
    assertErr(result);

    expect(result.error.kind).toBe("not_found");
    if (result.error.kind === "not_found") {
      expect(result.error.id).toBe("f-ghost");
    }
  });

  test("error: not_pending echoes current_status='active'", () => {
    const memory = makeMemory([makeFact({ id: "f-1", status: "active" })]);
    const result = approveFactCore(memory, "f-1", now);
    assertErr(result);

    expect(result.error.kind).toBe("not_pending");
    if (result.error.kind === "not_pending") {
      expect(result.error.current_status).toBe("active");
    }
  });

  test("error: not_pending echoes current_status='retired'", () => {
    const memory = makeMemory([
      makeFact({ id: "f-1", status: "retired", retired_reason: "user_rejected" }),
    ]);
    const result = approveFactCore(memory, "f-1", now);
    assertErr(result);

    expect(result.error.kind).toBe("not_pending");
    if (result.error.kind === "not_pending") {
      expect(result.error.current_status).toBe("retired");
    }
  });

  test("immutability: input memory.facts array unchanged after call", () => {
    const pending = makeFact({ id: "f-1", status: "pending" });
    const memory = makeMemory([pending]);
    const facts = memory.facts;
    const snapshot = JSON.stringify(memory);

    const result = approveFactCore(memory, "f-1", now);
    assertOk(result);

    // input still has the original pending fact
    expect(JSON.stringify(memory)).toBe(snapshot);
    expect(memory.facts).toBe(facts); // same array reference
    expect(memory.facts[0]).toBe(pending); // same fact reference
    expect(memory.facts[0]?.status).toBe("pending");
    // returned memory is a new object with a new facts array
    expect(result.memory).not.toBe(memory);
    expect(result.memory.facts).not.toBe(facts);
  });

  test("uses default now when omitted", () => {
    const before = Date.now();
    const memory = makeMemory([makeFact({ id: "f-1", status: "pending" })]);
    const result = approveFactCore(memory, "f-1");
    assertOk(result);

    const ts = Date.parse(result.fact.last_seen_at);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// retireFactCore
// ---------------------------------------------------------------------------

describe("retireFactCore", () => {
  test("happy from pending: status→retired, retired_reason→user_rejected, last_seen_at NOT bumped (CLI parity)", () => {
    const pending = makeFact({
      id: "f-1",
      status: "pending",
      retired_reason: null,
      last_seen_at: "2026-05-15T00:00:00.000Z",
    });
    const memory = makeMemory([pending]);

    const result = retireFactCore(memory, "f-1", now);
    assertOk(result);

    expect(result.fact.status).toBe("retired");
    expect(result.fact.retired_reason).toBe("user_rejected");
    expect(result.fact.last_seen_at).toBe("2026-05-15T00:00:00.000Z");
    expect(result.memory.facts[0]?.status).toBe("retired");
    expect(result.memory.facts[0]?.retired_reason).toBe("user_rejected");
  });

  test("happy from active: status→retired, retired_reason→user_rejected, last_seen_at preserved", () => {
    const active = makeFact({
      id: "f-1",
      status: "active",
      retired_reason: null,
      last_seen_at: "2026-05-15T00:00:00.000Z",
    });
    const memory = makeMemory([active]);

    const result = retireFactCore(memory, "f-1", now);
    assertOk(result);

    expect(result.fact.status).toBe("retired");
    expect(result.fact.retired_reason).toBe("user_rejected");
    expect(result.fact.last_seen_at).toBe("2026-05-15T00:00:00.000Z");
  });

  test("idempotent on already-retired: returned memory === input memory (reference equality)", () => {
    const retired = makeFact({
      id: "f-1",
      status: "retired",
      retired_reason: "user_rejected",
      last_seen_at: "2026-05-15T00:00:00.000Z",
    });
    const memory = makeMemory([retired]);

    const result = retireFactCore(memory, "f-1", now);
    assertOk(result);

    // Reference equality — the signal for HTTP caller to skip writeMemory
    expect(result.memory).toBe(memory);
    expect(result.fact).toBe(retired);
    // last_seen_at NOT bumped
    expect(result.fact.last_seen_at).toBe("2026-05-15T00:00:00.000Z");
  });

  test("error: not_found when id absent", () => {
    const memory = makeMemory([makeFact({ id: "f-real" })]);
    const result = retireFactCore(memory, "f-ghost", now);
    assertErr(result);

    expect(result.error.kind).toBe("not_found");
    if (result.error.kind === "not_found") {
      expect(result.error.id).toBe("f-ghost");
    }
  });

  test("immutability: input memory.facts array unchanged after non-idempotent call", () => {
    const pending = makeFact({ id: "f-1", status: "pending" });
    const memory = makeMemory([pending]);
    const facts = memory.facts;
    const snapshot = JSON.stringify(memory);

    const result = retireFactCore(memory, "f-1", now);
    assertOk(result);

    expect(JSON.stringify(memory)).toBe(snapshot);
    expect(memory.facts).toBe(facts);
    expect(memory.facts[0]).toBe(pending);
    expect(memory.facts[0]?.status).toBe("pending");
    expect(memory.facts[0]?.retired_reason).toBeNull();
    expect(result.memory).not.toBe(memory);
    expect(result.memory.facts).not.toBe(facts);
  });

  test("preserves siblings in facts array", () => {
    const a = makeFact({ id: "f-aaa", status: "active" });
    const target = makeFact({ id: "f-bbb", status: "pending" });
    const c = makeFact({
      id: "f-ccc",
      status: "retired",
      retired_reason: "superseded",
    });
    const memory = makeMemory([a, target, c]);

    const result = retireFactCore(memory, "f-bbb", now);
    assertOk(result);

    expect(result.memory.facts).toHaveLength(3);
    expect(result.memory.facts[0]).toBe(a);
    expect(result.memory.facts[2]).toBe(c);
    expect(result.memory.facts[1]?.id).toBe("f-bbb");
    expect(result.memory.facts[1]?.status).toBe("retired");
    expect(result.memory.facts[1]?.retired_reason).toBe("user_rejected");
  });

  test("accepts optional now param (currently unused; signature symmetry w/ approveFactCore)", () => {
    const memory = makeMemory([
      makeFact({
        id: "f-1",
        status: "pending",
        last_seen_at: "2026-05-15T00:00:00.000Z",
      }),
    ]);
    // Passing a custom now must not change observable behavior since retire
    // does not bump last_seen_at (CLI parity).
    const result = retireFactCore(memory, "f-1", () => "1999-01-01T00:00:00.000Z");
    assertOk(result);
    expect(result.fact.last_seen_at).toBe("2026-05-15T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// reactivateFactCore
// ---------------------------------------------------------------------------

describe("reactivateFactCore", () => {
  test("happy from retired: status→active, retired_reason cleared, last_seen+confirmed bumped", () => {
    const retired = makeFact({
      id: "f-1",
      status: "retired",
      retired_reason: "user_rejected",
      last_seen_at: "2026-05-15T00:00:00.000Z",
      last_confirmed_at: null,
    });
    const result = reactivateFactCore(makeMemory([retired]), "f-1", now);
    assertOk(result);

    expect(result.fact.status).toBe("active");
    expect(result.fact.retired_reason).toBeNull();
    expect(result.fact.last_seen_at).toBe(FROZEN_NOW);
    expect(result.fact.last_confirmed_at).toBe(FROZEN_NOW);
    expect(result.memory.facts[0]?.status).toBe("active");
  });

  test("error: not_retired when fact is active (with current_status)", () => {
    const active = makeFact({ id: "f-1", status: "active" });
    const result = reactivateFactCore(makeMemory([active]), "f-1", now);
    assertErr(result);
    expect(result.error.kind).toBe("not_retired");
    if (result.error.kind === "not_retired") {
      expect(result.error.current_status).toBe("active");
    }
  });

  test("error: not_found when id absent", () => {
    const result = reactivateFactCore(
      makeMemory([makeFact({ id: "f-real" })]),
      "f-ghost",
      now,
    );
    assertErr(result);
    expect(result.error.kind).toBe("not_found");
  });

  test("immutability: input memory + target fact unchanged", () => {
    const retired = makeFact({ id: "f-1", status: "retired", retired_reason: "user_rejected" });
    const memory = makeMemory([retired]);
    const facts = memory.facts;
    const result = reactivateFactCore(memory, "f-1", now);
    assertOk(result);

    expect(memory.facts).toBe(facts);
    expect(memory.facts[0]).toBe(retired);
    expect(memory.facts[0]?.status).toBe("retired");
    expect(result.memory).not.toBe(memory);
    expect(result.memory.facts).not.toBe(facts);
  });
});

// ---------------------------------------------------------------------------
// confirmRetireFactCore
// ---------------------------------------------------------------------------

describe("confirmRetireFactCore", () => {
  test("retire_proposed → retired with reason decayed", () => {
    const f = makeFact({ id: "f-1", status: "retire_proposed" });
    const res = confirmRetireFactCore(makeMemory([f]), "f-1");
    assertOk(res);
    expect(res.fact.status).toBe("retired");
    expect(res.fact.retired_reason).toBe("decayed");
  });

  test("rejects a fact that is not retire_proposed", () => {
    const f = makeFact({ id: "f-1", status: "active" });
    const res = confirmRetireFactCore(makeMemory([f]), "f-1");
    assertErr(res);
    expect(res.error.kind).toBe("not_retire_proposed");
  });

  test("not_found for unknown id", () => {
    const res = confirmRetireFactCore(makeMemory([]), "nope");
    assertErr(res);
    expect(res.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// keepFactCore
// ---------------------------------------------------------------------------

describe("keepFactCore", () => {
  test("retire_proposed → active and refreshes last_seen_at", () => {
    const f = makeFact({
      id: "f-1",
      status: "retire_proposed",
      last_seen_at: "2026-01-01T00:00:00.000Z",
    });
    const res = keepFactCore(makeMemory([f]), "f-1", () => "2026-06-24T00:00:00.000Z");
    assertOk(res);
    expect(res.fact.status).toBe("active");
    expect(res.fact.last_seen_at).toBe("2026-06-24T00:00:00.000Z");
    // Keep is a reconfirmation → last_confirmed_at stamped.
    expect(res.fact.last_confirmed_at).toBe("2026-06-24T00:00:00.000Z");
  });

  test("rejects a fact that is not retire_proposed", () => {
    const f = makeFact({ id: "f-1", status: "active" });
    const res = keepFactCore(makeMemory([f]), "f-1");
    assertErr(res);
    expect(res.error.kind).toBe("not_retire_proposed");
  });

  test("not_found for unknown id", () => {
    const res = keepFactCore(makeMemory([]), "nope");
    assertErr(res);
    expect(res.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// setFactPinnedCore
// ---------------------------------------------------------------------------

describe("setFactPinnedCore", () => {
  test("pins an active fact", () => {
    const f = makeFact({ id: "f-1", status: "active", pinned: false });
    const res = setFactPinnedCore(makeMemory([f]), "f-1", true);
    assertOk(res);
    expect(res.fact.pinned).toBe(true);
  });

  test("unpins a pinned fact", () => {
    const f = makeFact({ id: "f-1", status: "active", pinned: true });
    const res = setFactPinnedCore(makeMemory([f]), "f-1", false);
    assertOk(res);
    expect(res.fact.pinned).toBe(false);
  });

  test("rejects pinning a retired fact", () => {
    const f = makeFact({ id: "f-1", status: "retired" });
    const res = setFactPinnedCore(makeMemory([f]), "f-1", true);
    assertErr(res);
    expect(res.error.kind).toBe("already_retired");
  });
});

// ---------------------------------------------------------------------------
// addFactCore
// ---------------------------------------------------------------------------

describe("addFactCore", () => {
  test("creates a pending fact with id shape f-* and the right defaults", () => {
    const memory = makeMemory([]);
    const result = addFactCore(
      memory,
      { text: "loves pink", confidence: 0.9, save_reason: "user typed via /memory" },
      now,
    );
    assertOk(result);

    expect(result.fact.id).toMatch(/^f-[0-9a-f]{8}$/);
    expect(result.fact.text).toBe("loves pink");
    expect(result.fact.status).toBe("pending");
    expect(result.fact.confidence).toBe(0.9);
    expect(result.fact.created_at).toBe(FROZEN_NOW);
    expect(result.fact.last_seen_at).toBe(FROZEN_NOW);
    expect(result.fact.last_confirmed_at).toBeNull();
    expect(result.fact.stability).toBe("durable");
    expect(result.fact.learned_from).toEqual({ stream: "user", session_id: null });
    expect(result.fact.save_reason).toBe("user typed via /memory");
    expect(result.fact.supersedes).toBeNull();
    expect(result.fact.superseded_by).toBeNull();
    expect(result.fact.invalid_at).toBeNull();
    expect(result.fact.pinned).toBe(false);

    // appended to facts
    expect(result.memory.facts).toHaveLength(1);
    expect(result.memory.facts[0]?.id).toBe(result.fact.id);
  });

  test("save_reason defaults to null when omitted", () => {
    const result = addFactCore(makeMemory([]), { text: "x", confidence: 0.8 }, now);
    assertOk(result);
    expect(result.fact.save_reason).toBeNull();
  });

  test("supersedes: links old.superseded_by to new id but old stays ACTIVE", () => {
    const old = makeFact({ id: "f-old", status: "active", superseded_by: null });
    const memory = makeMemory([old]);
    const result = addFactCore(
      memory,
      { text: "new claim", confidence: 0.9, supersedes: "f-old" },
      now,
    );
    assertOk(result);

    // new fact is pending and points back at the old one
    expect(result.fact.status).toBe("pending");
    expect(result.fact.supersedes).toBe("f-old");

    const oldAfter = result.memory.facts.find((f) => f.id === "f-old");
    expect(oldAfter?.status).toBe("active"); // NOT retired yet
    expect(oldAfter?.superseded_by).toBe(result.fact.id);
    expect(oldAfter?.invalid_at).toBeNull(); // not stamped until approval

    expect(result.memory.facts).toHaveLength(2);
  });

  test("error: not_found when supersedes names a missing fact", () => {
    const result = addFactCore(
      makeMemory([makeFact({ id: "f-real" })]),
      { text: "x", confidence: 0.9, supersedes: "f-ghost" },
      now,
    );
    assertErr(result);
    expect(result.error.kind).toBe("not_found");
    if (result.error.kind === "not_found") {
      expect(result.error.id).toBe("f-ghost");
    }
  });

  test("immutability: input memory + facts array unchanged", () => {
    const old = makeFact({ id: "f-old", status: "active" });
    const memory = makeMemory([old]);
    const facts = memory.facts;
    const snapshot = JSON.stringify(memory);

    const result = addFactCore(
      memory,
      { text: "new", confidence: 0.9, supersedes: "f-old" },
      now,
    );
    assertOk(result);

    expect(JSON.stringify(memory)).toBe(snapshot);
    expect(memory.facts).toBe(facts);
    expect(memory.facts[0]).toBe(old);
    expect(memory.facts[0]?.superseded_by).toBeNull();
    expect(result.memory).not.toBe(memory);
    expect(result.memory.facts).not.toBe(facts);
  });
});

// ---------------------------------------------------------------------------
// restateFactCore
// ---------------------------------------------------------------------------

describe("restateFactCore", () => {
  test("active fact → reconfirm: refreshes last_seen_at + last_confirmed_at, status unchanged", () => {
    const active = makeFact({
      id: "f-1",
      status: "active",
      last_seen_at: "2026-01-01T00:00:00.000Z",
      last_confirmed_at: "2026-01-01T00:00:00.000Z",
    });
    const result = restateFactCore(makeMemory([active]), "f-1", now);
    assertOk(result);

    expect(result.fact.status).toBe("active");
    expect(result.fact.last_seen_at).toBe(FROZEN_NOW);
    expect(result.fact.last_confirmed_at).toBe(FROZEN_NOW);
  });

  test("pending fact → approve (delegates to approveFactCore semantics)", () => {
    const pending = makeFact({
      id: "f-1",
      status: "pending",
      last_confirmed_at: null,
    });
    const result = restateFactCore(makeMemory([pending]), "f-1", now);
    assertOk(result);

    expect(result.fact.status).toBe("active");
    expect(result.fact.last_seen_at).toBe(FROZEN_NOW);
    expect(result.fact.last_confirmed_at).toBe(FROZEN_NOW);
  });

  test("error: not_found when id absent", () => {
    const result = restateFactCore(makeMemory([makeFact({ id: "f-real" })]), "f-ghost", now);
    assertErr(result);
    expect(result.error.kind).toBe("not_found");
    if (result.error.kind === "not_found") {
      expect(result.error.id).toBe("f-ghost");
    }
  });

  test("immutability: input memory + target fact unchanged (active path)", () => {
    const active = makeFact({ id: "f-1", status: "active", last_seen_at: "2026-01-01T00:00:00.000Z" });
    const memory = makeMemory([active]);
    const facts = memory.facts;

    const result = restateFactCore(memory, "f-1", now);
    assertOk(result);

    expect(memory.facts).toBe(facts);
    expect(memory.facts[0]).toBe(active);
    expect(memory.facts[0]?.last_seen_at).toBe("2026-01-01T00:00:00.000Z");
    expect(result.memory).not.toBe(memory);
  });

  test("active fact → bumps recall_count by 1 (0→1, then 1→2 on a second restate)", () => {
    const active = makeFact({ id: "f-1", status: "active", recall_count: 0 });

    const first = restateFactCore(makeMemory([active]), "f-1", now);
    assertOk(first);
    expect(first.fact.recall_count).toBe(1);

    // Restating the already-bumped fact bumps again.
    const second = restateFactCore(first.memory, "f-1", now);
    assertOk(second);
    expect(second.fact.recall_count).toBe(2);
  });

  test("pending→approve path does NOT bump recall_count (first approval ≠ reaffirmation)", () => {
    const pending = makeFact({ id: "f-1", status: "pending", recall_count: 0 });
    const result = restateFactCore(makeMemory([pending]), "f-1", now);
    assertOk(result);

    expect(result.fact.status).toBe("active");
    expect(result.fact.recall_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// approveFactCore — supersession resolution
// ---------------------------------------------------------------------------

describe("approveFactCore (supersession resolution)", () => {
  test("approving a fact with supersedes: old → retired+superseded+invalid_at, link intact; new → active", () => {
    const old = makeFact({
      id: "f-old",
      status: "active",
      superseded_by: "f-new",
      invalid_at: null,
    });
    const newFact = makeFact({
      id: "f-new",
      status: "pending",
      supersedes: "f-old",
    });
    const memory = makeMemory([old, newFact]);

    const result = approveFactCore(memory, "f-new", now);
    assertOk(result);

    // new fact is active
    expect(result.fact.id).toBe("f-new");
    expect(result.fact.status).toBe("active");
    expect(result.fact.last_confirmed_at).toBe(FROZEN_NOW);

    // old fact is retired with superseded reason + invalid_at stamped + link intact
    const oldAfter = result.memory.facts.find((f) => f.id === "f-old");
    expect(oldAfter?.status).toBe("retired");
    expect(oldAfter?.retired_reason).toBe("superseded");
    expect(oldAfter?.invalid_at).toBe(FROZEN_NOW);
    expect(oldAfter?.superseded_by).toBe("f-new"); // link preserved
  });

  test("approving a non-superseding fact leaves siblings untouched (no spurious retire)", () => {
    const other = makeFact({ id: "f-other", status: "active" });
    const newFact = makeFact({ id: "f-new", status: "pending", supersedes: null });
    const result = approveFactCore(makeMemory([other, newFact]), "f-new", now);
    assertOk(result);

    expect(result.memory.facts.find((f) => f.id === "f-other")?.status).toBe("active");
    expect(result.fact.status).toBe("active");
  });

  test("supersedes names a missing old fact: still approves the new fact (no throw)", () => {
    const newFact = makeFact({ id: "f-new", status: "pending", supersedes: "f-gone" });
    const result = approveFactCore(makeMemory([newFact]), "f-new", now);
    assertOk(result);
    expect(result.fact.status).toBe("active");
  });

  test("immutability: input memory unchanged on supersession resolution", () => {
    const old = makeFact({ id: "f-old", status: "active", superseded_by: "f-new" });
    const newFact = makeFact({ id: "f-new", status: "pending", supersedes: "f-old" });
    const memory = makeMemory([old, newFact]);
    const snapshot = JSON.stringify(memory);

    const result = approveFactCore(memory, "f-new", now);
    assertOk(result);

    expect(JSON.stringify(memory)).toBe(snapshot);
    expect(memory.facts[0]?.status).toBe("active");
    expect(memory.facts[0]?.invalid_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// retireFactCore — reject path clears the old fact's superseded_by
// ---------------------------------------------------------------------------

describe("retireFactCore (reject clears supersession link)", () => {
  test("rejecting a superseding fact clears old.superseded_by, old stays active", () => {
    const old = makeFact({
      id: "f-old",
      status: "active",
      superseded_by: "f-new",
    });
    const newFact = makeFact({
      id: "f-new",
      status: "pending",
      supersedes: "f-old",
    });
    const memory = makeMemory([old, newFact]);

    const result = retireFactCore(memory, "f-new", now);
    assertOk(result);

    // new fact retired
    expect(result.fact.status).toBe("retired");
    expect(result.fact.retired_reason).toBe("user_rejected");

    // old fact unchanged status + link cleared
    const oldAfter = result.memory.facts.find((f) => f.id === "f-old");
    expect(oldAfter?.status).toBe("active");
    expect(oldAfter?.superseded_by).toBeNull();
    expect(oldAfter?.invalid_at).toBeNull();
  });

  test("does not touch an old fact whose superseded_by points elsewhere", () => {
    const old = makeFact({ id: "f-old", status: "active", superseded_by: "f-someoneelse" });
    const newFact = makeFact({ id: "f-new", status: "pending", supersedes: "f-old" });
    const result = retireFactCore(makeMemory([old, newFact]), "f-new", now);
    assertOk(result);

    const oldAfter = result.memory.facts.find((f) => f.id === "f-old");
    expect(oldAfter?.superseded_by).toBe("f-someoneelse"); // untouched
  });

  test("immutability: input memory unchanged on reject-with-supersedes", () => {
    const old = makeFact({ id: "f-old", status: "active", superseded_by: "f-new" });
    const newFact = makeFact({ id: "f-new", status: "pending", supersedes: "f-old" });
    const memory = makeMemory([old, newFact]);
    const snapshot = JSON.stringify(memory);

    const result = retireFactCore(memory, "f-new", now);
    assertOk(result);

    expect(JSON.stringify(memory)).toBe(snapshot);
    expect(memory.facts[0]?.superseded_by).toBe("f-new");
  });
});

// ---------------------------------------------------------------------------
// Action-log: event appends per transition Core fn
// ---------------------------------------------------------------------------

describe("action-log: addFactCore", () => {
  test("appends a created event to the new fact", () => {
    const result = addFactCore(makeMemory([]), { text: "x", confidence: 0.9 }, now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "created", at: FROZEN_NOW, reason: null });
  });
});

describe("action-log: approveFactCore", () => {
  test("appends an approved event on the approved fact", () => {
    const pending = makeFact({ id: "f-1", status: "pending" });
    const result = approveFactCore(makeMemory([pending]), "f-1", now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "approved", at: FROZEN_NOW, reason: null });
  });

  test("supersession resolution appends retired{reason:superseded} to the old fact", () => {
    const old = makeFact({ id: "f-old", status: "active", superseded_by: "f-new" });
    const newFact = makeFact({ id: "f-new", status: "pending", supersedes: "f-old" });
    const result = approveFactCore(makeMemory([old, newFact]), "f-new", now);
    assertOk(result);
    const oldAfter = result.memory.facts.find((f) => f.id === "f-old");
    expect(oldAfter?.events.at(-1)).toMatchObject({ action: "retired", at: FROZEN_NOW, reason: "superseded" });
  });
});

describe("action-log: restateFactCore", () => {
  test("reaffirm (active) path appends a reaffirmed event", () => {
    const active = makeFact({ id: "f-1", status: "active" });
    const result = restateFactCore(makeMemory([active]), "f-1", now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "reaffirmed", at: FROZEN_NOW, reason: null });
  });

  test("approve-pending path appends approved (not reaffirmed)", () => {
    const pending = makeFact({ id: "f-1", status: "pending" });
    const result = restateFactCore(makeMemory([pending]), "f-1", now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "approved", at: FROZEN_NOW, reason: null });
  });
});

describe("action-log: retireFactCore", () => {
  test("appends retired{reason:user_rejected} on non-idempotent retire", () => {
    const active = makeFact({ id: "f-1", status: "active" });
    const result = retireFactCore(makeMemory([active]), "f-1", now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "retired", at: FROZEN_NOW, reason: "user_rejected" });
  });

  test("idempotent path (already-retired) does not append an event", () => {
    const retired = makeFact({
      id: "f-1",
      status: "retired",
      retired_reason: "user_rejected",
      events: [{ action: "retired", at: "2026-05-15T00:00:00.000Z", reason: "user_rejected" }],
    });
    const result = retireFactCore(makeMemory([retired]), "f-1", now);
    assertOk(result);
    // Idempotent: same fact reference returned, events untouched
    expect(result.fact).toBe(retired);
    expect(result.fact.events).toHaveLength(1);
  });
});

describe("action-log: confirmRetireFactCore", () => {
  test("appends retired{reason:decayed}", () => {
    const rp = makeFact({ id: "f-1", status: "retire_proposed" });
    const result = confirmRetireFactCore(makeMemory([rp]), "f-1", now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "retired", at: FROZEN_NOW, reason: "decayed" });
  });
});

describe("action-log: reactivateFactCore", () => {
  test("appends a reactivated event", () => {
    const retired = makeFact({ id: "f-1", status: "retired", retired_reason: "user_rejected" });
    const result = reactivateFactCore(makeMemory([retired]), "f-1", now);
    assertOk(result);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "reactivated", at: FROZEN_NOW, reason: null });
  });
});

describe("INV1: recall_count === reaffirmed-event count", () => {
  test("recall_count matches events.filter(reaffirmed) after a reaffirm sequence", () => {
    const active = makeFact({ id: "f-1", status: "active", recall_count: 0 });
    let memory = makeMemory([active]);

    const r1 = restateFactCore(memory, "f-1", now);
    assertOk(r1);
    memory = r1.memory;

    const r2 = restateFactCore(memory, "f-1", now);
    assertOk(r2);

    const finalFact = r2.fact;
    const reaffirmCount = finalFact.events.filter((e) => e.action === "reaffirmed").length;
    expect(finalFact.recall_count).toBe(reaffirmCount);
    expect(reaffirmCount).toBe(2);
  });
});

describe("INV2: state change implies exactly one appended event", () => {
  test("addFactCore: new fact has exactly 1 event (started from 0)", () => {
    const result = addFactCore(makeMemory([]), { text: "y", confidence: 0.8 }, now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(1);
  });

  test("approveFactCore: returned fact has input.events.length + 1", () => {
    const pending = makeFact({ id: "f-1", status: "pending", events: [] });
    const result = approveFactCore(makeMemory([pending]), "f-1", now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(pending.events.length + 1);
  });

  test("restateFactCore (reaffirm): returned fact has input.events.length + 1", () => {
    const active = makeFact({ id: "f-1", status: "active", events: [] });
    const result = restateFactCore(makeMemory([active]), "f-1", now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(active.events.length + 1);
  });

  test("retireFactCore: returned fact has input.events.length + 1", () => {
    const active = makeFact({ id: "f-1", status: "active", events: [] });
    const result = retireFactCore(makeMemory([active]), "f-1", now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(active.events.length + 1);
  });

  test("confirmRetireFactCore: returned fact has input.events.length + 1", () => {
    const rp = makeFact({ id: "f-1", status: "retire_proposed", events: [] });
    const result = confirmRetireFactCore(makeMemory([rp]), "f-1", now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(rp.events.length + 1);
  });

  test("reactivateFactCore: returned fact has input.events.length + 1", () => {
    const retired = makeFact({ id: "f-1", status: "retired", retired_reason: "user_rejected", events: [] });
    const result = reactivateFactCore(makeMemory([retired]), "f-1", now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(retired.events.length + 1);
  });

  test("keepFactCore: returned fact has input.events.length + 1 and appends reactivated event", () => {
    const rp = makeFact({ id: "f-1", status: "retire_proposed", events: [] });
    const result = keepFactCore(makeMemory([rp]), "f-1", now);
    assertOk(result);
    expect(result.fact.events).toHaveLength(rp.events.length + 1);
    expect(result.fact.events.at(-1)).toMatchObject({ action: "reactivated", at: FROZEN_NOW, reason: null });
  });
});

// ---------------------------------------------------------------------------
// approveFactCore — stale-supersession guard
// ---------------------------------------------------------------------------

describe("approveFactCore: stale pending supersession (target already retired)", () => {
  test("C1: approving a stale pending does NOT re-stamp the already-retired target", () => {
    const RETIRE_TS = "2026-05-16T00:00:00.000Z";
    // Target was ALREADY retired by an auto-supersede (f-auto got there first).
    const target = makeFact({
      id: "f-dog",
      text: "user is a dog person",
      status: "retired",
      retired_reason: "superseded",
      superseded_by: "f-auto",
      invalid_at: RETIRE_TS,
      events: [
        { action: "created", at: "2026-05-15T00:00:00.000Z", reason: null },
        { action: "retired", at: RETIRE_TS, reason: "superseded" },
      ],
    });
    const auto = makeFact({
      id: "f-auto",
      text: "user is a cat person",
      status: "active",
      supersedes: "f-dog",
    });
    // A mid-band pending-replace against the same target, approved LATE.
    const stalePending = makeFact({
      id: "f-stale",
      text: "user is a bird person",
      status: "pending",
      supersedes: "f-dog",
      events: [{ action: "created", at: "2026-05-15T00:00:00.000Z", reason: null }],
    });
    const memory = makeMemory([target, auto, stalePending]);

    const result = approveFactCore(memory, "f-stale", now);
    assertOk(result);

    // The pending fact still becomes active normally; its supersedes link stays
    // as-is (historically accurate).
    expect(result.fact.status).toBe("active");
    expect(result.fact.supersedes).toBe("f-dog");

    // The already-retired target is NOT re-stamped.
    const dog = result.memory.facts.find((f) => f.id === "f-dog")!;
    expect(dog.superseded_by).toBe("f-auto"); // not overwritten to f-stale
    expect(dog.events.filter((e) => e.action === "retired")).toHaveLength(1); // no 2nd retired event
    expect(dog.invalid_at).toBe(RETIRE_TS); // not clobbered to now
    expect(dog.status).toBe("retired");
    expect(dog.retired_reason).toBe("superseded");
  });

  // C1b (final-pass regression): the guard must skip ONLY `retired` targets.
  // A `retire_proposed` target (decay sweep soft-tombstone — which appends NO
  // event on active→retire_proposed) must STILL get the retire-stamp on
  // approve; otherwise it strands in the decay-confirm queue and a later
  // "keep" would reactivate it alongside its own replacement (two actives for
  // one claim). This exact case regressed when the guard was first written as
  // `status === "active"`.
  test("C1b: approving a supersession whose target is retire_proposed still retires it", () => {
    const target = makeFact({
      id: "f-dog",
      text: "user is a dog person",
      status: "retire_proposed",
      events: [{ action: "created", at: "2026-05-15T00:00:00.000Z", reason: null }],
    });
    const pending = makeFact({
      id: "f-cat",
      text: "user is a cat person",
      status: "pending",
      supersedes: "f-dog",
      events: [{ action: "created", at: "2026-05-15T00:00:00.000Z", reason: null }],
    });
    const memory = makeMemory([target, pending]);

    const result = approveFactCore(memory, "f-cat", now);
    assertOk(result);

    expect(result.fact.status).toBe("active");
    const dog = result.memory.facts.find((f) => f.id === "f-dog")!;
    expect(dog.status).toBe("retired");
    expect(dog.retired_reason).toBe("superseded");
    expect(dog.superseded_by).toBe("f-cat");
    expect(dog.invalid_at).not.toBeNull();
    // Exactly ONE retired event (decay's active→retire_proposed appends none).
    expect(dog.events.filter((e) => e.action === "retired")).toHaveLength(1);
  });
});
