import { describe, expect, it } from "bun:test";
import {
  readActiveFacts,
  buildUserContextBlock,
  classifyFactKind,
  backfillFactKind,
  readActiveStyleFacts,
} from "../../src/memory/recall";
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

describe("readActiveFacts", () => {
  it("INV1 — keeps only status==='active' (drops pending/retired/retire_proposed)", () => {
    const facts = [
      fact({ id: "a", status: "active" }),
      fact({ id: "p", status: "pending" }),
      fact({ id: "r", status: "retired" }),
      fact({ id: "rp", status: "retire_proposed" }),
    ];
    const active = readActiveFacts({ facts } as CoreMemory);
    expect(active.map((f) => f.id)).toEqual(["a"]);
  });

  it("anti-trap — includes active facts whose learned_from is null (no stream filter)", () => {
    // The two highest-value real facts (concise-answers, beginner-friendly) carry stream:null.
    const facts = [
      fact({ id: "null-stream", status: "active", learned_from: null }),
      fact({
        id: "user-stream",
        status: "active",
        learned_from: { stream: "user", session_id: null },
      }),
    ];
    const active = readActiveFacts({ facts } as CoreMemory);
    expect(active.map((f) => f.id).sort()).toEqual(["null-stream", "user-stream"]);
  });
});

describe("buildUserContextBlock", () => {
  it("INV2 — empty active set returns '' (no scaffold)", () => {
    expect(buildUserContextBlock([])).toBe("");
  });

  it("wraps each active fact's text in a <user_context> block", () => {
    const block = buildUserContextBlock([
      fact({ id: "c", text: "the user prefers concise answers" }),
      fact({ id: "d", text: "User's partner is Alex" }),
    ]);
    expect(block).toContain("<user_context>");
    expect(block).toContain("</user_context>");
    expect(block).toContain("the user prefers concise answers");
    expect(block).toContain("User's partner is Alex");
  });

  it("appends anti-over-steer framing (background-not-commands)", () => {
    const block = buildUserContextBlock([fact({ text: "User prefers the color teal" })]);
    // background framing + explicit anti-recite/anti-shoehorn guard
    expect(block.toLowerCase()).toContain("background");
    expect(block.toLowerCase()).toContain("only when");
    expect(block.toLowerCase()).toMatch(/do not recite|never.*unprompted|not.*force/);
    // style-vs-profile logic carried by instruction (no per-fact tag)
    expect(block.toLowerCase()).toContain("style");
  });

  it("pinned facts ordered before non-pinned, original order within groups", () => {
    const block = buildUserContextBlock([
      fact({ id: "n1", text: "AAA", pinned: false }),
      fact({ id: "p1", text: "BBB", pinned: true }),
      fact({ id: "n2", text: "CCC", pinned: false }),
    ]);
    const aaa = block.indexOf("AAA");
    const bbb = block.indexOf("BBB");
    const ccc = block.indexOf("CCC");
    expect(bbb).toBeLessThan(aaa); // pinned BBB first
    expect(aaa).toBeLessThan(ccc); // non-pinned keep original AAA before CCC
  });
});

describe("classifyFactKind", () => {
  it("tags real communication-style facts as style", () => {
    expect(classifyFactKind("the user prefers concise answers")).toBe("style");
    expect(classifyFactKind("the user prefers beginner-friendly explanations without assuming deep expertise")).toBe("style");
  });

  it("tags personal-profile facts as profile", () => {
    expect(classifyFactKind("User's partner is Alex")).toBe("profile");
    expect(classifyFactKind("User prefers the color teal")).toBe("profile");
    expect(classifyFactKind("User likes dogs")).toBe("profile");
    expect(classifyFactKind("User prefers to add Starbucks caramel oat milk when drinking coffee")).toBe("profile");
  });
});

describe("backfillFactKind (idempotent)", () => {
  it("seeds kind only on untagged (null) facts, leaves tagged ones unchanged", () => {
    const mem = {
      facts: [
        fact({ id: "zh", text: "the user prefers concise answers", kind: null }),
        fact({ id: "dan", text: "User's partner is Alex", kind: null }),
        fact({ id: "pre", text: "User's partner is Alex", kind: "style" }), // mistag preserved
      ],
    } as CoreMemory;
    const out = backfillFactKind(mem);
    expect(out.facts.find((f) => f.id === "zh")?.kind).toBe("style");
    expect(out.facts.find((f) => f.id === "dan")?.kind).toBe("profile");
    expect(out.facts.find((f) => f.id === "pre")?.kind).toBe("style"); // not re-classified
  });

  it("is idempotent — second pass changes nothing", () => {
    const mem = { facts: [fact({ text: "User likes dogs", kind: null })] } as CoreMemory;
    const once = backfillFactKind(mem);
    const twice = backfillFactKind(once);
    expect(twice.facts[0].kind).toBe("profile");
    expect(twice.facts).toEqual(once.facts);
  });
});

describe("readActiveStyleFacts (Brain filter)", () => {
  it("returns only active + kind==='style'; excludes profile, null-kind, retired-style", () => {
    const mem = {
      facts: [
        fact({ id: "s", status: "active", kind: "style" }),
        fact({ id: "p", status: "active", kind: "profile" }),
        fact({ id: "u", status: "active", kind: null }),
        fact({ id: "rs", status: "retired", kind: "style" }),
      ],
    } as CoreMemory;
    expect(readActiveStyleFacts(mem).map((f) => f.id)).toEqual(["s"]);
  });

  it("INV1 — never returns a profile fact (no leak to the critic)", () => {
    const mem = {
      facts: [fact({ id: "dan", text: "User's partner is Alex", status: "active", kind: "profile" })],
    } as CoreMemory;
    expect(readActiveStyleFacts(mem)).toEqual([]);
  });
});
