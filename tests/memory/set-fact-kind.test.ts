import { describe, expect, it } from "bun:test";
import { setFactKindCore } from "../../src/memory/transitions";
import { backfillFactKind, readActiveStyleFacts } from "../../src/memory/recall";
import { emptyMemory } from "../../src/memory/memory";
import type { CoreMemory, Fact } from "../../src/memory/memory";

function fact(over: Partial<Fact>): Fact {
  return {
    id: "f-1",
    text: "x",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-29T00:00:00.000Z",
    last_seen_at: "2026-06-29T00:00:00.000Z",
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

const mem = (facts: Fact[]): CoreMemory => ({ ...emptyMemory(), facts });
const NOW = () => "2026-06-29T12:00:00.000Z";

describe("setFactKindCore", () => {
  it("sets ONLY kind (every other field byte-identical)", () => {
    const before = fact({ id: "a", text: "User likes cats", kind: null });
    const res = setFactKindCore(mem([before]), "a", "profile", NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fact.kind).toBe("profile");
    const { kind: _after, ...restAfter } = res.fact;
    const { kind: _before, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore); // nothing else moved
  });

  it("idempotent — same kind returns the input memory REFERENCE (caller skips write)", () => {
    const m = mem([fact({ id: "a", kind: "style" })]);
    const res = setFactKindCore(m, "a", "style", NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.memory).toBe(m); // reference equality → no write
  });

  it("unknown id → not_found", () => {
    const res = setFactKindCore(mem([fact({ id: "a" })]), "nope", "style", NOW);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("not_found");
  });

  it("a manual re-tag is NOT overwritten by the startup backfill", () => {
    // user re-tags a Chinese-preference fact (which the seed classifier would call
    // "style") to profile; backfillFactKind must leave the manual choice alone.
    const m = mem([fact({ id: "zh", text: "the user prefers responses in Chinese", kind: null })]);
    const tagged = setFactKindCore(m, "zh", "profile", NOW);
    expect(tagged.ok).toBe(true);
    if (!tagged.ok) return;
    const afterBackfill = backfillFactKind(tagged.memory);
    expect(afterBackfill.facts.find((f) => f.id === "zh")?.kind).toBe("profile"); // not re-classified to style
  });

  it("re-tag style→profile drops the fact from the critic recall filter", () => {
    const m = mem([fact({ id: "zh", text: "prefers Chinese", status: "active", kind: "style" })]);
    expect(readActiveStyleFacts(m).map((f) => f.id)).toEqual(["zh"]); // critic sees it
    const res = setFactKindCore(m, "zh", "profile", NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readActiveStyleFacts(res.memory)).toEqual([]); // critic no longer sees it
  });
});
