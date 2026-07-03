import { describe, expect, test } from "bun:test";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import {
  captureChatFactCore,
  captureChatFactsCore,
} from "../../src/memory/transitions";

const FROZEN_NOW = "2026-06-29T12:00:00.000Z";
const now = () => FROZEN_NOW;

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-aaaaaaaa",
    text: "pnpm",
    source_session_id: null,
    confidence: 1.0,
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    last_seen_at: "2026-06-01T00:00:00.000Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: { stream: "chat", session_id: null },
    kind: null,
    last_confirmed_at: "2026-06-01T00:00:00.000Z",
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
    last_consolidated_at: "2026-06-01T00:00:00.000Z",
    consolidation_due_at: "2026-06-08T00:00:00.000Z",
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

describe("captureChatFactCore", () => {
  test("新建 active fact 形状正确", () => {
    const memory = makeMemory([]);
    const result = captureChatFactCore(memory, "我用 pnpm 不用 npm", now);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.deduped).toBe(false);
    expect(result.memory.facts.length).toBe(1);

    const f = result.fact;
    expect(f.text).toBe("我用 pnpm 不用 npm");
    expect(f.status).toBe("active");
    expect(f.learned_from).toEqual({ stream: "chat", session_id: null });
    expect(f.kind).toBe(null);
    expect(f.pinned).toBe(false);
    expect(f.stability).toBe("durable");
    expect(f.confidence).toBe(1.0);
    expect(f.created_at).toBe(FROZEN_NOW);
    expect(f.last_seen_at).toBe(FROZEN_NOW);
    expect(f.last_confirmed_at).toBe(FROZEN_NOW);
    expect(f.events).toEqual([
      { action: "created", at: FROZEN_NOW, reason: null },
    ]);
    // no saveReason arg → save_reason stays null (backward-compat default).
    expect(f.save_reason).toBe(null);
    // immutability — input untouched.
    expect(memory.facts.length).toBe(0);
  });

  // saveReason arg is written onto the new fact so the /memory "Why" line
  // shows real provenance instead of "no source recorded (early memory)".
  test("saveReason 写入新 fact 的 save_reason", () => {
    const memory = makeMemory([]);
    const result = captureChatFactCore(
      memory,
      "喜欢奶油海绵蛋糕",
      now,
      "noticed in chat",
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.deduped).toBe(false);
    expect(result.fact.save_reason).toBe("noticed in chat");
  });

  // Dedupe vs existing active same text → no new fact + refresh + deduped:true.
  test("去重: 已有 active 同文 → 不新增, 刷新 last_confirmed_at", () => {
    const existing = makeFact({
      id: "f-existing",
      text: "pnpm",
      last_seen_at: "2026-06-01T00:00:00.000Z",
      last_confirmed_at: "2026-06-01T00:00:00.000Z",
      recall_count: 2,
      events: [{ action: "created", at: "2026-06-01T00:00:00.000Z", reason: null }],
    });
    const memory = makeMemory([existing]);
    const result = captureChatFactCore(memory, "pnpm", now);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.deduped).toBe(true);
    expect(result.memory.facts.length).toBe(1);
    expect(result.fact.id).toBe("f-existing");
    // BOTH clocks refreshed (last_seen_at is the decay clock) + recall bumped.
    expect(result.fact.last_confirmed_at).toBe(FROZEN_NOW);
    expect(result.fact.last_seen_at).toBe(FROZEN_NOW);
    expect(result.fact.recall_count).toBe(3);
    // appended a reaffirm event — assert the action label, not just at/reason
    // (a "created" event with the same at/reason would otherwise pass vacuously).
    const last = result.fact.events.at(-1)!;
    expect(last.action).toBe("reaffirmed");
    expect(last.at).toBe(FROZEN_NOW);
    expect(last.reason).toBe("chat_repeat");
  });

  // Same text but existing fact is retired (or pending) → NEW active fact created.
  test("同文但已 retired → 新建 active (不去重)", () => {
    const retired = makeFact({
      id: "f-retired",
      text: "pnpm",
      status: "retired",
      retired_reason: "user_rejected",
    });
    const memory = makeMemory([retired]);
    const result = captureChatFactCore(memory, "pnpm", now);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.deduped).toBe(false);
    expect(result.memory.facts.length).toBe(2);
    expect(result.fact.status).toBe("active");
    expect(result.fact.id).not.toBe("f-retired");
  });

  test("同文但 pending → 新建 active (不去重)", () => {
    const pending = makeFact({ id: "f-pending", text: "pnpm", status: "pending" });
    const memory = makeMemory([pending]);
    const result = captureChatFactCore(memory, "pnpm", now);
    if (!result.ok) throw new Error("expected ok");
    expect(result.deduped).toBe(false);
    expect(result.memory.facts.length).toBe(2);
  });

  // Normalization (trim + lowercase) for the compare only.
  test("归一化: '  PNPM  ' 命中存储的 'pnpm'", () => {
    const existing = makeFact({ id: "f-existing", text: "pnpm" });
    const memory = makeMemory([existing]);
    const result = captureChatFactCore(memory, "  PNPM  ", now);
    if (!result.ok) throw new Error("expected ok");
    expect(result.deduped).toBe(true);
    expect(result.memory.facts.length).toBe(1);
    expect(result.fact.id).toBe("f-existing");
    // stored text never mutated.
    expect(result.fact.text).toBe("pnpm");
  });

  // Empty / whitespace-only text is a contract violation (caller guards this);
  // the core throws rather than persisting a zero-length fact.
  test("空 payload → throw (调用方必须先守卫)", () => {
    const memory = makeMemory([]);
    expect(() => captureChatFactCore(memory, "", now)).toThrow(/empty text/);
    expect(() => captureChatFactCore(memory, "   ", now)).toThrow(/empty text/);
  });

  // Entities (entity model) thread onto the new fact when given.
  test("captureChatFactCore stores entities on the new fact", () => {
    const memory = makeMemory([]);
    const result = captureChatFactCore(memory, "likes cats", now, null, [{ name: "cats" }]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.fact.entities).toEqual([{ name: "cats" }]);
  });

  // No entities arg (legacy callers) → field stays absent, not `[]`
  // (preserves the optional round-trip / legacy-untagged predicate).
  test("无 entities 参数 → entities 字段缺省 (不是空数组)", () => {
    const memory = makeMemory([]);
    const result = captureChatFactCore(memory, "我用 pnpm 不用 npm", now);
    if (!result.ok) throw new Error("expected ok");
    expect(result.fact.entities).toBeUndefined();
  });
});

describe("captureChatFactsCore (batch)", () => {
  // Two fresh claims → 2 saved, both deduped:false, memory gains 2 facts.
  test("两条新声明 → 2 saved, 都 deduped:false, memory +2", () => {
    const memory = makeMemory([]);
    const { memory: out, saved } = captureChatFactsCore(
      memory,
      [{ text: "喜欢奶油海绵蛋糕" }, { text: "喜欢奥利奥海盐奶油" }],
      now,
    );

    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.deduped)).toEqual([false, false]);
    expect(saved.map((s) => s.text)).toEqual([
      "喜欢奶油海绵蛋糕",
      "喜欢奥利奥海盐奶油",
    ]);
    expect(out.facts).toHaveLength(2);
    // immutability — input untouched.
    expect(memory.facts).toHaveLength(0);
  });

  // saveReason threads onto every fresh fact in the batch.
  test("saveReason 写入批次内每条新 fact", () => {
    const memory = makeMemory([]);
    const { memory: out } = captureChatFactsCore(
      memory,
      [{ text: "喜欢奶油海绵蛋糕" }, { text: "喜欢奥利奥海盐奶油" }],
      now,
      "noticed in chat",
    );
    expect(out.facts.map((f) => f.save_reason)).toEqual([
      "noticed in chat",
      "noticed in chat",
    ]);
  });

  // One claim matching an existing active fact → deduped:true, no dup.
  test("命中已有 active 同文 → deduped:true, 不新增", () => {
    const existing = makeFact({ id: "f-existing", text: "pnpm" });
    const memory = makeMemory([existing]);
    const { memory: out, saved } = captureChatFactsCore(memory, [{ text: "pnpm" }], now);

    expect(saved).toHaveLength(1);
    expect(saved[0]!.deduped).toBe(true);
    expect(saved[0]!.text).toBe("pnpm");
    expect(out.facts).toHaveLength(1); // no duplicate
  });

  // Blank/whitespace claim skipped (captureChatFactCore would throw on empty).
  test("空白声明被跳过, 不抛", () => {
    const memory = makeMemory([]);
    const { memory: out, saved } = captureChatFactsCore(
      memory,
      [{ text: "   " }, { text: "我用 pnpm" }],
      now,
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]!.text).toBe("我用 pnpm");
    expect(out.facts).toHaveLength(1);
  });

  // Mix (one new + one dup) → saved has both with correct deduped flags.
  test("混合 (一新一重) → deduped 标记各自正确", () => {
    const existing = makeFact({ id: "f-existing", text: "pnpm" });
    const memory = makeMemory([existing]);
    const { memory: out, saved } = captureChatFactsCore(
      memory,
      [{ text: "pnpm" }, { text: "我喜欢猫" }],
      now,
    );

    expect(saved).toHaveLength(2);
    expect(saved[0]!.deduped).toBe(true); // existing "pnpm" reaffirmed
    expect(saved[1]!.deduped).toBe(false); // "我喜欢猫" is new
    expect(out.facts).toHaveLength(2); // 1 existing + 1 new
  });

  // Per-item entities (entity model) thread through independently;
  // an item with no `entities` key leaves the field absent on its fact.
  test("captureChatFactsCore carries per-item entities", () => {
    const memory = makeMemory([]);
    const { memory: out } = captureChatFactsCore(
      memory,
      [{ text: "boyfriend Daniel", entities: [{ name: "Daniel" }] }, { text: "no ent" }],
      now,
    );
    const daniel = out.facts.find((f) => f.text === "boyfriend Daniel");
    expect(daniel?.entities).toEqual([{ name: "Daniel" }]);
    expect(out.facts.find((f) => f.text === "no ent")?.entities).toBeUndefined();
  });
});
