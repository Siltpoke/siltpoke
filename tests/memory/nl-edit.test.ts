/**
 * Unit tests for the NL memory-edit parser. The Brain call is stubbed; we
 * test the schema validation + the in-code re-derivation of the untrusted LLM
 * verdict (the part that guards against phantom/stale targets). The prompt's
 * numeric-difference guard is model behavior — covered by a cost-gated paid
 * smoke, not here.
 */
import { describe, expect, test } from "bun:test";
import type { Fact } from "../../src/memory/memory";
import { type BrainRawFn, parseMemoryEdit } from "../../src/memory/nl-edit";

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-aaaaaaaa",
    text: "User prefers dark mode",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    last_seen_at: "2026-06-01T00:00:00.000Z",
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

/** Brain stub returning a fixed parsed output. */
function stubBrain(output: unknown): BrainRawFn {
  return async () => ({ output });
}

describe("parseMemoryEdit", () => {
  test("add: net-new claim, no target", async () => {
    const r = await parseMemoryEdit("记得我喜欢粉红色", [makeFact()], {
      brainFn: stubBrain({
        candidate_claim: "User prefers pink",
        classification: "add",
        target_fact_id: null,
        confidence: 0.9,
      }),
    });
    expect(r.classification).toBe("add");
    expect(r.target_fact_id).toBeNull();
    expect(r.candidate_claim).toBe("User prefers pink");
  });

  test("restate: matches an existing active fact → keeps target", async () => {
    const fact = makeFact({ id: "f-dark", status: "active" });
    const r = await parseMemoryEdit("我还是喜欢深色模式", [fact], {
      brainFn: stubBrain({
        candidate_claim: "User prefers dark mode",
        classification: "restate",
        target_fact_id: "f-dark",
        confidence: 0.95,
      }),
    });
    expect(r.classification).toBe("restate");
    expect(r.target_fact_id).toBe("f-dark");
  });

  test("contradict: directly contradicts an active fact → keeps target", async () => {
    const fact = makeFact({ id: "f-dark", status: "active" });
    const r = await parseMemoryEdit("其实我喜欢浅色模式", [fact], {
      brainFn: stubBrain({
        candidate_claim: "User prefers light mode",
        classification: "contradict",
        target_fact_id: "f-dark",
        confidence: 0.9,
      }),
    });
    expect(r.classification).toBe("contradict");
    expect(r.target_fact_id).toBe("f-dark");
  });

  test("untrusted downgrade: contradict naming an UNKNOWN id → add", async () => {
    const r = await parseMemoryEdit("foo", [makeFact({ id: "f-real" })], {
      brainFn: stubBrain({
        candidate_claim: "User likes foo",
        classification: "contradict",
        target_fact_id: "f-phantom",
        confidence: 0.8,
      }),
    });
    expect(r.classification).toBe("add");
    expect(r.target_fact_id).toBeNull();
  });

  test("untrusted downgrade: restate naming a NON-ACTIVE fact → add", async () => {
    const retired = makeFact({ id: "f-old", status: "retired" });
    const r = await parseMemoryEdit("bar", [retired], {
      brainFn: stubBrain({
        candidate_claim: "User likes bar",
        classification: "restate",
        target_fact_id: "f-old",
        confidence: 0.8,
      }),
    });
    expect(r.classification).toBe("add");
    expect(r.target_fact_id).toBeNull();
  });

  test("add classification always nulls any target the LLM returned", async () => {
    const r = await parseMemoryEdit("baz", [makeFact({ id: "f-x" })], {
      brainFn: stubBrain({
        candidate_claim: "User likes baz",
        classification: "add",
        target_fact_id: "f-x",
        confidence: 0.7,
      }),
    });
    expect(r.target_fact_id).toBeNull();
  });

  test("malformed LLM output throws", async () => {
    await expect(
      parseMemoryEdit("x", [], {
        brainFn: stubBrain({ not: "the right shape" }),
      }),
    ).rejects.toThrow(/schema validation/);
  });

  test("empty active facts → add", async () => {
    const r = await parseMemoryEdit("记得我用 bun", [], {
      brainFn: stubBrain({
        candidate_claim: "User uses bun",
        classification: "add",
        target_fact_id: null,
        confidence: 0.85,
      }),
    });
    expect(r.classification).toBe("add");
  });
});
