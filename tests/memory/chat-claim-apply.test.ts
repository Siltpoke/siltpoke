import { describe, expect, test } from "bun:test";
import {
  applyChatClaimsCore,
  type ClassifiedClaim,
  proposeChatFactCore,
  supersedeChatFactCore,
} from "../../src/memory/chat-claim-apply";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import { approveFactCore, type TransitionResult } from "../../src/memory/transitions";

// ---------------------------------------------------------------------------
// Test fixtures (mirror tests/memory/transitions.test.ts)
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
    throw new Error(`expected ok result but got error: ${JSON.stringify(result.error)}`);
  }
}

// ---------------------------------------------------------------------------
// supersedeChatFactCore
// ---------------------------------------------------------------------------

describe("supersedeChatFactCore", () => {
  test("atomicity: new fact born ACTIVE + old retired in the SAME returned memory, links bidirectional, invalid_at set", () => {
    const old = makeFact({
      id: "f-dog",
      text: "user is a dog person",
      status: "active",
      learned_from: { stream: "chat", session_id: null },
    });
    const memory = makeMemory([old]);

    const result = supersedeChatFactCore(memory, {
      text: "user is a cat person",
      targetId: "f-dog",
      ts: FROZEN_NOW,
    });

    expect(result.fact).not.toBeNull();
    expect(result.retired).not.toBeNull();
    const newFact = result.fact!;
    const retired = result.retired!;

    // New fact: born active, chat provenance, confidence 1.0, supersedes link.
    expect(newFact.status).toBe("active");
    expect(newFact.text).toBe("user is a cat person");
    expect(newFact.confidence).toBe(1.0);
    expect(newFact.learned_from).toEqual({ stream: "chat", session_id: null });
    expect(newFact.kind).toBeNull();
    expect(newFact.pinned).toBe(false);
    expect(newFact.stability).toBe("durable");
    expect(newFact.supersedes).toBe("f-dog");
    expect(newFact.superseded_by).toBeNull();
    expect(newFact.created_at).toBe(FROZEN_NOW);
    expect(newFact.last_seen_at).toBe(FROZEN_NOW);
    expect(newFact.last_confirmed_at).toBe(FROZEN_NOW);
    expect(newFact.save_reason).toBeNull(); // default when not threaded
    expect(newFact.events).toEqual([{ action: "created", at: FROZEN_NOW, reason: null }]);

    // Old fact: retired with the approveFactCore retire-block semantics.
    expect(retired.id).toBe("f-dog");
    expect(retired.status).toBe("retired");
    expect(retired.retired_reason).toBe("superseded");
    expect(retired.superseded_by).toBe(newFact.id);
    expect(retired.invalid_at).toBe(FROZEN_NOW);
    expect(retired.events.at(-1)).toMatchObject({
      action: "retired",
      at: FROZEN_NOW,
      reason: "superseded",
    });

    // BOTH changes live in the one returned memory (single atomic result):
    // exactly one active + one retired — never both retired, never both active.
    const facts = result.memory.facts;
    expect(facts).toHaveLength(2);
    const inMemOld = facts.find((f) => f.id === "f-dog")!;
    const inMemNew = facts.find((f) => f.id === newFact.id)!;
    expect(inMemOld.status).toBe("retired");
    expect(inMemNew.status).toBe("active");

    // Input memory never mutated.
    expect(memory.facts[0]?.status).toBe("active");
    expect(memory.facts[0]?.superseded_by).toBeNull();
  });

  test("saveReason threads onto the new fact (I5)", () => {
    const memory = makeMemory([makeFact({ id: "f-1", status: "active" })]);
    const result = supersedeChatFactCore(memory, {
      text: "user is a cat person",
      targetId: "f-1",
      ts: FROZEN_NOW,
      saveReason: "chat_auto_capture",
    });
    expect(result.fact?.save_reason).toBe("chat_auto_capture");
  });

  test("entities thread onto the new fact (captureChatFactCore shape: omitted when empty)", () => {
    const old = makeFact({ id: "f-1", status: "active" });
    const withEntities = supersedeChatFactCore(makeMemory([old]), {
      text: "user is a cat person",
      entities: [{ name: "cats", type: "hobby" }],
      targetId: "f-1",
      ts: FROZEN_NOW,
    });
    expect(withEntities.fact?.entities).toEqual([{ name: "cats", type: "hobby" }]);

    const withoutEntities = supersedeChatFactCore(makeMemory([makeFact({ id: "f-1", status: "active" })]), {
      text: "user is a cat person",
      targetId: "f-1",
      ts: FROZEN_NOW,
    });
    expect(withoutEntities.fact && "entities" in withoutEntities.fact).toBe(false);
  });

  test("belt: phantom target → memory returned reference-equal, no fact", () => {
    const memory = makeMemory([makeFact({ id: "f-1", status: "active" })]);
    const result = supersedeChatFactCore(memory, {
      text: "x",
      targetId: "f-ghost",
      ts: FROZEN_NOW,
    });
    expect(result.memory).toBe(memory); // reference-equal = caller skips writeMemory
    expect(result.fact).toBeNull();
    expect(result.retired).toBeNull();
  });

  test.each(["pending", "retired", "retire_proposed"] as const)(
    "belt: non-active target (%s) → memory returned reference-equal, no fact",
    (status) => {
      const target = makeFact({
        id: "f-1",
        status,
        retired_reason: status === "retired" ? "user_rejected" : null,
      });
      const memory = makeMemory([target]);
      const result = supersedeChatFactCore(memory, {
        text: "x",
        targetId: "f-1",
        ts: FROZEN_NOW,
      });
      expect(result.memory).toBe(memory);
      expect(result.fact).toBeNull();
    },
  );

  test("chain: superseding the superseder links old→new→newer, nothing deleted", () => {
    const old = makeFact({ id: "f-dog", text: "dog person", status: "active" });
    const memory = makeMemory([old]);

    // Correction: dog → cat.
    const first = supersedeChatFactCore(memory, {
      text: "cat person",
      targetId: "f-dog",
      ts: FROZEN_NOW,
    });
    const catId = first.fact!.id;

    // Undo: cat → dog again (fresh fact — the retired original is NOT reactivated).
    const LATER = "2026-05-18T12:05:00.000Z";
    const second = supersedeChatFactCore(first.memory, {
      text: "dog person after all",
      targetId: catId,
      ts: LATER,
    });
    const newerId = second.fact!.id;

    const facts = second.memory.facts;
    expect(facts).toHaveLength(3); // nothing deleted
    const dog = facts.find((f) => f.id === "f-dog")!;
    const cat = facts.find((f) => f.id === catId)!;
    const newer = facts.find((f) => f.id === newerId)!;

    expect(dog.status).toBe("retired");
    expect(dog.superseded_by).toBe(catId);
    expect(cat.status).toBe("retired");
    expect(cat.supersedes).toBe("f-dog");
    expect(cat.superseded_by).toBe(newerId);
    expect(cat.retired_reason).toBe("superseded");
    expect(cat.invalid_at).toBe(LATER);
    expect(newer.status).toBe("active");
    expect(newer.supersedes).toBe(catId);
    expect(newer.superseded_by).toBeNull();
  });

  test("empty text throws (caller-guard contract, mirrors captureChatFactCore)", () => {
    const memory = makeMemory([makeFact({ id: "f-1", status: "active" })]);
    expect(() =>
      supersedeChatFactCore(memory, { text: "   ", targetId: "f-1", ts: FROZEN_NOW }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// proposeChatFactCore
// ---------------------------------------------------------------------------

describe("proposeChatFactCore", () => {
  test("shape: new fact born PENDING with supersedes link + chat provenance; last_confirmed_at null", () => {
    const target = makeFact({
      id: "f-dog",
      text: "user is a dog person",
      status: "active",
    });
    const memory = makeMemory([target]);

    const result = proposeChatFactCore(memory, {
      text: "user is a cat person",
      entities: [{ name: "cats" }],
      targetId: "f-dog",
      ts: FROZEN_NOW,
      saveReason: "chat_auto_capture",
    });

    expect(result.fact).not.toBeNull();
    const pending = result.fact!;
    expect(pending.status).toBe("pending");
    expect(pending.text).toBe("user is a cat person");
    expect(pending.confidence).toBe(1.0);
    expect(pending.supersedes).toBe("f-dog");
    expect(pending.superseded_by).toBeNull();
    expect(pending.learned_from).toEqual({ stream: "chat", session_id: null });
    expect(pending.kind).toBeNull();
    expect(pending.stability).toBe("durable");
    expect(pending.pinned).toBe(false);
    expect(pending.created_at).toBe(FROZEN_NOW);
    expect(pending.last_seen_at).toBe(FROZEN_NOW);
    expect(pending.last_confirmed_at).toBeNull(); // pending-first: not yet confirmed
    expect(pending.save_reason).toBe("chat_auto_capture");
    expect(pending.entities).toEqual([{ name: "cats" }]);
    expect(pending.events).toEqual([{ action: "created", at: FROZEN_NOW, reason: null }]);

    // Target stays ACTIVE and literally untouched (reference-equal), and is
    // returned as `target` (oldText source for the marker).
    expect(result.target).toBe(target);
    const inMem = result.memory.facts.find((f) => f.id === "f-dog")!;
    expect(inMem).toBe(target);
    expect(inMem.superseded_by).toBeNull(); // deliberately NO addFactCore-style proposed-link
    expect(result.memory.facts).toHaveLength(2);

    // Input memory never mutated.
    expect(memory.facts).toHaveLength(1);
  });

  test("belt: phantom / non-active target → memory returned reference-equal, no fact", () => {
    const retired = makeFact({ id: "f-old", status: "retired", retired_reason: "user_rejected" });
    const memory = makeMemory([retired]);

    const phantom = proposeChatFactCore(memory, { text: "x", targetId: "f-ghost", ts: FROZEN_NOW });
    expect(phantom.memory).toBe(memory);
    expect(phantom.fact).toBeNull();
    expect(phantom.target).toBeNull();

    const nonActive = proposeChatFactCore(memory, { text: "x", targetId: "f-old", ts: FROZEN_NOW });
    expect(nonActive.memory).toBe(memory);
    expect(nonActive.fact).toBeNull();
  });

  test("empty text throws (caller-guard contract)", () => {
    const memory = makeMemory([makeFact({ id: "f-1", status: "active" })]);
    expect(() =>
      proposeChatFactCore(memory, { text: " ", targetId: "f-1", ts: FROZEN_NOW }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyChatClaimsCore
// ---------------------------------------------------------------------------

describe("applyChatClaimsCore", () => {
  const activeDog = () =>
    makeFact({
      id: "f-dog",
      text: "user is a dog person",
      status: "active",
      learned_from: { stream: "chat", session_id: null },
      recall_count: 0,
      events: [{ action: "created", at: "2026-05-15T00:00:00.000Z", reason: null }],
    });

  test("add → captureChatFactCore path: fresh active fact, outcome 'saved'", () => {
    const memory = makeMemory([]);
    const claims: ClassifiedClaim[] = [
      { text: "user likes cake", classification: "add", targetId: null },
    ];
    const { memory: out, results, droppedCount } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(droppedCount).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "saved", text: "user likes cake" });
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]).toMatchObject({
      text: "user likes cake",
      status: "active",
      confidence: 1.0,
      learned_from: { stream: "chat", session_id: null },
    });
    expect(memory.facts).toHaveLength(0); // input untouched
  });

  test("saveReason threads onto every created fact (add / replaced / proposed) (I5)", () => {
    const memory = makeMemory([
      activeDog(),
      makeFact({ id: "f-tea", text: "user drinks tea", status: "active" }),
    ]);
    const claims: ClassifiedClaim[] = [
      { text: "user likes cake", classification: "add", targetId: null },
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog", tier: "auto" },
      { text: "user drinks coffee", classification: "contradict", targetId: "f-tea", tier: "pending" },
    ];
    const { memory: out } = applyChatClaimsCore(memory, claims, FROZEN_NOW, "chat_auto_capture");

    expect(out.facts.find((f) => f.text === "user likes cake")?.save_reason).toBe("chat_auto_capture");
    expect(out.facts.find((f) => f.text === "user is a cat person")?.save_reason).toBe("chat_auto_capture");
    expect(out.facts.find((f) => f.text === "user drinks coffee")?.save_reason).toBe("chat_auto_capture");
  });

  test("add duplicating an existing active fact → dedupe-reaffirm, outcome 'reaffirmed'", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a dog person", classification: "add", targetId: null },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results[0]).toMatchObject({ outcome: "reaffirmed", factId: "f-dog" });
    expect(out.facts).toHaveLength(1); // no duplicate
    expect(out.facts[0]?.last_confirmed_at).toBe(FROZEN_NOW);
    expect(out.facts[0]?.recall_count).toBe(1);
  });

  test("restate with valid active target → reaffirm in place (captureChatFactCore dedupe fields)", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "yep still a dog person", classification: "restate", targetId: "f-dog" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results[0]).toMatchObject({ outcome: "reaffirmed", factId: "f-dog" });
    expect(out.facts).toHaveLength(1); // no new fact
    const fact = out.facts[0]!;
    expect(fact.text).toBe("user is a dog person"); // stored text never mutated
    expect(fact.status).toBe("active");
    expect(fact.last_seen_at).toBe(FROZEN_NOW);
    expect(fact.last_confirmed_at).toBe(FROZEN_NOW);
    expect(fact.recall_count).toBe(1);
    expect(fact.events.at(-1)).toMatchObject({ action: "reaffirmed", at: FROZEN_NOW });
  });

  test("restate with phantom / non-active target → treated as add", () => {
    const retired = makeFact({ id: "f-old", status: "retired", retired_reason: "user_rejected" });
    const memory = makeMemory([retired]);
    const claims: ClassifiedClaim[] = [
      { text: "user codes in typescript", classification: "restate", targetId: "f-old" },
      { text: "user drinks oolong", classification: "restate", targetId: null },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results[0]).toMatchObject({ outcome: "saved", text: "user codes in typescript" });
    expect(results[1]).toMatchObject({ outcome: "saved", text: "user drinks oolong" });
    expect(out.facts).toHaveLength(3);
    expect(out.facts.find((f) => f.id === "f-old")?.status).toBe("retired"); // untouched
  });

  test("contradict + tier auto → supersede; result carries oldText/newText for the [REPLACED] marker", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog", tier: "auto" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.outcome).toBe("replaced");
    if (r.outcome !== "replaced") throw new Error("unreachable");
    expect(r.oldText).toBe("user is a dog person");
    expect(r.newText).toBe("user is a cat person");
    expect(r.oldFactId).toBe("f-dog");

    const newFact = out.facts.find((f) => f.id === r.factId)!;
    expect(newFact.status).toBe("active");
    expect(newFact.supersedes).toBe("f-dog");
    const oldFact = out.facts.find((f) => f.id === "f-dog")!;
    expect(oldFact.status).toBe("retired");
    expect(oldFact.retired_reason).toBe("superseded");
    expect(oldFact.superseded_by).toBe(r.factId);
    expect(oldFact.invalid_at).toBe(FROZEN_NOW);
  });

  test("contradict + tier pending → new fact born PENDING with supersedes link, target stays ACTIVE untouched", () => {
    const target = activeDog();
    const memory = makeMemory([target]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog", tier: "pending" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    const r = results[0]!;
    expect(r.outcome).toBe("proposed");
    if (r.outcome !== "proposed") throw new Error("unreachable");
    expect(r.oldText).toBe("user is a dog person");
    expect(r.newText).toBe("user is a cat person");

    expect(out.facts).toHaveLength(2);
    const pending = out.facts.find((f) => f.id === r.factId)!;
    expect(pending.status).toBe("pending");
    expect(pending.supersedes).toBe("f-dog");
    expect(pending.learned_from).toEqual({ stream: "chat", session_id: null });
    expect(pending.events).toEqual([{ action: "created", at: FROZEN_NOW, reason: null }]);

    // Target stays ACTIVE and byte-identical (reference-equal — literally untouched).
    const old = out.facts.find((f) => f.id === "f-dog")!;
    expect(old).toBe(target);

    // The EXISTING /memory approve flow completes the flip later, via approveFactCore.
    const approved = approveFactCore(out, r.factId, now);
    assertOk(approved);
    const flippedOld = approved.memory.facts.find((f) => f.id === "f-dog")!;
    expect(flippedOld.status).toBe("retired");
    expect(flippedOld.retired_reason).toBe("superseded");
    expect(flippedOld.superseded_by).toBe(r.factId);
    expect(flippedOld.invalid_at).toBe(FROZEN_NOW);
    expect(approved.fact.status).toBe("active");
  });

  test("contradict + tier drop → store unchanged (reference-equal), counted in droppedCount, no marker payload", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog", tier: "drop" },
    ];
    const { memory: out, results, droppedCount } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(out).toBe(memory); // all claims dropped → caller can skip writeMemory
    expect(droppedCount).toBe(1);
    expect(results[0]).toEqual({ outcome: "dropped", text: "user is a cat person" });
  });

  test("contradict + tier drop with a phantom target still drops (explicit floor wins over downgrade-to-add)", () => {
    const memory = makeMemory([]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-ghost", tier: "drop" },
    ];
    const { memory: out, results, droppedCount } = applyChatClaimsCore(memory, claims, FROZEN_NOW);
    expect(out).toBe(memory);
    expect(droppedCount).toBe(1);
    expect(results[0]).toEqual({ outcome: "dropped", text: "user is a cat person" });
  });

  test("contradict with phantom / non-active target → downgrade to add (never phantom-supersede)", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-ghost", tier: "auto" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results[0]).toMatchObject({ outcome: "saved", text: "user is a cat person" });
    expect(out.facts).toHaveLength(2);
    expect(out.facts.find((f) => f.id === "f-dog")?.status).toBe("active"); // untouched
    expect(out.facts.find((f) => f.text === "user is a cat person")?.supersedes).toBeNull();
  });

  test("contradict with missing tier → conservative default 'pending' (never auto-retire without an explicit tier)", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results[0]?.outcome).toBe("proposed");
    expect(out.facts.find((f) => f.id === "f-dog")?.status).toBe("active");
  });

  test("multi-claim: one add + one contradict land in ONE returned memory", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user likes cake", classification: "add", targetId: null },
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog", tier: "auto" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results.map((r) => r.outcome)).toEqual(["saved", "replaced"]);
    expect(out.facts).toHaveLength(3);
    expect(out.facts.filter((f) => f.status === "active").map((f) => f.text).sort()).toEqual([
      "user is a cat person",
      "user likes cake",
    ]);
    expect(out.facts.find((f) => f.id === "f-dog")?.status).toBe("retired");
    // Input memory untouched — the caller's single writeMemory of `out` IS the atomicity.
    expect(memory.facts).toHaveLength(1);
    expect(memory.facts[0]?.status).toBe("active");
  });

  test("sequential semantics: two auto-contradicts against the SAME target — second sees the retire, downgrades to add", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      { text: "user is a cat person", classification: "contradict", targetId: "f-dog", tier: "auto" },
      { text: "user is a bird person", classification: "contradict", targetId: "f-dog", tier: "auto" },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results[0]?.outcome).toBe("replaced");
    // Honest semantic: the target is no longer active, so the second claim is
    // preserved as a plain add (visible pair) rather than silently dropped or
    // phantom-superseded.
    expect(results[1]).toMatchObject({ outcome: "saved", text: "user is a bird person" });

    expect(out.facts).toHaveLength(3);
    const dog = out.facts.find((f) => f.id === "f-dog")!;
    expect(dog.status).toBe("retired");
    const cat = out.facts.find((f) => f.text === "user is a cat person")!;
    expect(cat.status).toBe("active");
    expect(dog.superseded_by).toBe(cat.id); // only the FIRST contradict owns the link
    const bird = out.facts.find((f) => f.text === "user is a bird person")!;
    expect(bird.status).toBe("active");
    expect(bird.supersedes).toBeNull();
  });

  test("claim 2 sees claim 1's effect: add then exact-duplicate add → second reaffirms the first", () => {
    const memory = makeMemory([]);
    const claims: ClassifiedClaim[] = [
      { text: "user likes cake", classification: "add", targetId: null },
      { text: "user likes cake", classification: "add", targetId: null },
    ];
    const { memory: out, results } = applyChatClaimsCore(memory, claims, FROZEN_NOW);

    expect(results.map((r) => r.outcome)).toEqual(["saved", "reaffirmed"]);
    expect(out.facts).toHaveLength(1);
  });

  test("blank-text claims are skipped without a result entry (captureChatFactsCore idiom)", () => {
    const memory = makeMemory([]);
    const claims: ClassifiedClaim[] = [
      { text: "   ", classification: "add", targetId: null },
      { text: "user likes cake", classification: "add", targetId: null },
    ];
    const { results, droppedCount } = applyChatClaimsCore(memory, claims, FROZEN_NOW);
    expect(results).toHaveLength(1);
    expect(droppedCount).toBe(0);
  });

  test("entities thread through on add and supersede paths", () => {
    const memory = makeMemory([activeDog()]);
    const claims: ClassifiedClaim[] = [
      {
        text: "user is a cat person",
        entities: [{ name: "cats" }],
        classification: "contradict",
        targetId: "f-dog",
        tier: "auto",
      },
      {
        text: "user likes cake",
        entities: [{ name: "cake", type: "thing" }],
        classification: "add",
        targetId: null,
      },
    ];
    const { memory: out } = applyChatClaimsCore(memory, claims, FROZEN_NOW);
    expect(out.facts.find((f) => f.text === "user is a cat person")?.entities).toEqual([
      { name: "cats" },
    ]);
    expect(out.facts.find((f) => f.text === "user likes cake")?.entities).toEqual([
      { name: "cake", type: "thing" },
    ]);
  });

  test("empty claims list → memory reference-equal, empty results", () => {
    const memory = makeMemory([activeDog()]);
    const { memory: out, results, droppedCount } = applyChatClaimsCore(memory, [], FROZEN_NOW);
    expect(out).toBe(memory);
    expect(results).toEqual([]);
    expect(droppedCount).toBe(0);
  });
});
