import { describe, expect, test } from "bun:test";
import { entityKey, groupByEntity } from "../../src/memory/entity";
import type { Fact } from "../../src/memory/memory";

function fact(id: string, text: string, entities?: { name: string; type?: null }[]): Fact {
  return {
    id, text, source_session_id: null, confidence: 1, status: "active",
    created_at: "t", last_seen_at: "t", supersedes: null, superseded_by: null,
    pinned: false, recall_count: 0, retired_reason: null, stability: "durable",
    learned_from: { stream: "chat", session_id: null }, kind: null,
    last_confirmed_at: "t", expires_at: null, save_reason: null, invalid_at: null,
    events: [], ...(entities ? { entities } : {}),
  };
}

describe("entityKey", () => {
  test("folds case and collapses whitespace", () => {
    expect(entityKey("Daniel")).toBe("daniel");
    expect(entityKey("  My   Cat ")).toBe("my cat");
  });
});

describe("groupByEntity", () => {
  test("groups facts that share an entity key", () => {
    const facts = [
      fact("f1", "boyfriend Daniel", [{ name: "Daniel" }]),
      fact("f2", "Daniel likes hiking", [{ name: "daniel" }]),
    ];
    const groups = groupByEntity(facts);
    const daniel = groups.find((g) => g.key === "daniel");
    expect(daniel?.facts.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  test("a multi-entity fact appears under each entity", () => {
    const facts = [fact("f1", "Daniel likes cats", [{ name: "Daniel" }, { name: "cats" }])];
    const groups = groupByEntity(facts);
    expect(groups.find((g) => g.key === "daniel")?.facts).toHaveLength(1);
    expect(groups.find((g) => g.key === "cats")?.facts).toHaveLength(1);
  });

  test("untagged facts land in a trailing 未分类 group", () => {
    const facts = [fact("f1", "likes pink", [{ name: "pink" }]), fact("f2", "no entity")];
    const groups = groupByEntity(facts);
    expect(groups[groups.length - 1]).toMatchObject({ key: "", label: "未分类" });
    expect(groups[groups.length - 1]!.facts.map((f) => f.id)).toEqual(["f2"]);
  });

  test("treats a fact with no entities field as untagged (legacy round-trip)", () => {
    const facts = [fact("f1", "legacy")]; // no entities key at all
    const groups = groupByEntity(facts);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "" });
  });
});
