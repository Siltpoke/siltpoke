import { describe, expect, test } from "bun:test";
import { runTagEntities } from "../../src/cli/tag-entities";
import { emptyMemory } from "../../src/memory/memory";
import type { CoreMemory, Fact } from "../../src/memory/memory";

function factWith(overrides: Partial<Fact>): Fact {
  const now = new Date().toISOString();
  return {
    id: "f1",
    text: "likes cats",
    source_session_id: null,
    confidence: 1,
    status: "active",
    created_at: now,
    last_seen_at: now,
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    kind: null,
    entities: undefined,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    ...overrides,
  };
}

describe("runTagEntities", () => {
  test("tags untagged facts and reports the count", async () => {
    const writes: CoreMemory[] = [];
    const out: string[] = [];
    const memory: CoreMemory = { ...emptyMemory(), facts: [factWith({})] };

    const code = await runTagEntities({
      out: (s) => out.push(s),
      readMemory: async () => memory,
      writeMemory: async (_b, m) => {
        writes.push(m);
      },
      tagFn: async (m) => ({
        ...m,
        facts: m.facts.map((f) => ({ ...f, entities: [{ name: "cats" }] })),
      }),
      homeBase: "/tmp",
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("tagged 1");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.facts[0]?.entities).toEqual([{ name: "cats" }]);
  });

  test("reports nothing to tag when no untagged facts exist", async () => {
    const out: string[] = [];
    const memory: CoreMemory = {
      ...emptyMemory(),
      facts: [factWith({ entities: [{ name: "cats" }] })],
    };

    const code = await runTagEntities({
      out: (s) => out.push(s),
      readMemory: async () => memory,
      writeMemory: async () => {
        throw new Error("should not write when nothing to tag");
      },
      tagFn: async (m) => m,
      homeBase: "/tmp",
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("nothing to tag");
  });

  test("reports nothing to tag and skips write when the janitor degrades", async () => {
    // untaggedCount > 0 but tagFn degrades to returning the SAME memory
    // unchanged (the janitor's documented failure mode on a malformed/failed
    // LLM reply). The CLI must report "nothing to tag" AND must NOT write back
    // (a no-op write would round-trip the whole store for nothing).
    const out: string[] = [];
    const memory: CoreMemory = { ...emptyMemory(), facts: [factWith({})] };

    const code = await runTagEntities({
      out: (s) => out.push(s),
      readMemory: async () => memory,
      writeMemory: async () => {
        throw new Error("must not write when the janitor tagged nothing");
      },
      tagFn: async (m) => m,
      homeBase: "/tmp",
    });

    expect(code).toBe(0);
    expect(out.join("")).toContain("nothing to tag");
  });

  test("returns exit code 1 when no memory store is found", async () => {
    const out: string[] = [];

    const code = await runTagEntities({
      out: (s) => out.push(s),
      readMemory: async () => null,
      homeBase: "/tmp",
    });

    expect(code).toBe(1);
    expect(out.join("")).toContain("no memory store found");
  });
});
