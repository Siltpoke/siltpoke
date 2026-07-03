import { describe, expect, test } from "bun:test";
import { extractDurableFacts } from "../../src/memory/extract-facts";
import type { callBrainRaw } from "../../src/brain/brain";
import type { ledgerBrainCall } from "../../src/state/usage";

// A complete BrainUsage shape (callBrainRaw always returns all fields).
const USAGE = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 42,
  output_tokens: 7,
  total_cost_usd: 0.0001,
} as const;

/** Build a stub callBrainRaw that resolves with the given output + USAGE. */
function stubBrain(output: unknown): typeof callBrainRaw {
  return (async () => ({ output, usage: { ...USAGE } })) as typeof callBrainRaw;
}

const DEPS = { homeBase: "/tmp/siltpoke-test", sessionId: "sess-1" };

describe("extractDurableFacts", () => {
  // E1 — durable message → returns the model's facts[] (each with entities).
  test("E1 durable message → returns facts[]", async () => {
    const result = await extractDurableFacts("我喜欢吃奶油海绵蛋糕", DEPS, undefined, {
      callBrainRaw: stubBrain({ facts: [{ text: "喜欢奶油海绵蛋糕", entities: [] }] }),
      ledger: (async () => {}) as typeof ledgerBrainCall,
    });
    expect(result).toEqual([{ text: "喜欢奶油海绵蛋糕", entities: [] }]);
  });

  // E2 — malformed model output → [], BUT the real spend is still ledgered
  // (ledger-before-parse: the call cost tokens even though the shape was bad).
  test("E2 malformed output → [] but spend still ledgered", async () => {
    let ledgerCalls = 0;
    let ledgerKind = "";
    const result = await extractDurableFacts("我喜欢蛋糕", DEPS, undefined, {
      callBrainRaw: stubBrain({ nope: 1 }),
      ledger: (async (_base, args) => {
        ledgerCalls += 1;
        ledgerKind = args.kind;
      }) as typeof ledgerBrainCall,
    });
    expect(result).toEqual([]);
    // pins the headline design: malformed output still records the spend.
    expect(ledgerCalls).toBe(1);
    expect(ledgerKind).toBe("chat_capture");
  });

  // E3 — callBrainRaw throws → [] (never throws).
  test("E3 CLI throw → [] (never throws)", async () => {
    const throwing = (async () => {
      throw new Error("cli boom");
    }) as typeof callBrainRaw;
    let calls = 0;
    const result = await extractDurableFacts("我喜欢蛋糕", DEPS, undefined, {
      callBrainRaw: throwing,
      ledger: (async () => {
        calls += 1;
      }) as typeof ledgerBrainCall,
    });
    expect(result).toEqual([]);
    // No call completed → nothing spent → ledger NOT called.
    expect(calls).toBe(0);
  });

  // E4 — ledger called exactly once with kind:"chat_capture" + usage + session.
  test("E4 ledger called once with chat_capture kind + usage", async () => {
    const ledgerCalls: Array<{ basePath: string; args: unknown }> = [];
    await extractDurableFacts("我喜欢蛋糕", DEPS, undefined, {
      callBrainRaw: stubBrain({ facts: [{ text: "喜欢蛋糕", entities: [] }] }),
      ledger: (async (basePath: string, args: unknown) => {
        ledgerCalls.push({ basePath, args });
      }) as typeof ledgerBrainCall,
    });
    expect(ledgerCalls.length).toBe(1);
    const { basePath, args } = ledgerCalls[0]!;
    expect(basePath).toBe(DEPS.homeBase);
    const a = args as {
      kind: string;
      session_id: string;
      usage: typeof USAGE;
    };
    expect(a.kind).toBe("chat_capture");
    expect(a.session_id).toBe("sess-1");
    expect(a.usage.input_tokens).toBe(42);
    expect(a.usage.output_tokens).toBe(7);
  });

  // E5 — empty {facts:[]} → [] AND the call's usage is still ledgered.
  // (Decision: ledger fires after any successful call, before parse — a real
  // spend is recorded even when the model returned nothing durable.)
  test("E5 empty facts → [] and usage still ledgered", async () => {
    let calls = 0;
    const result = await extractDurableFacts("帮我看 bug", DEPS, undefined, {
      callBrainRaw: stubBrain({ facts: [] }),
      ledger: (async () => {
        calls += 1;
      }) as typeof ledgerBrainCall,
    });
    expect(result).toEqual([]);
    expect(calls).toBe(1);
  });

  // Extra — facts are trimmed and empty/whitespace entries dropped.
  test("trims facts and drops empties", async () => {
    const result = await extractDurableFacts("我喜欢蛋糕", DEPS, undefined, {
      callBrainRaw: stubBrain({
        facts: [
          { text: "  喜欢蛋糕  ", entities: [] },
          { text: "", entities: [] },
          { text: "   ", entities: [] },
        ],
      }),
      ledger: (async () => {}) as typeof ledgerBrainCall,
    });
    expect(result).toEqual([{ text: "喜欢蛋糕", entities: [] }]);
  });
});

describe("extractDurableFacts entities", () => {
  test("returns facts with their entities from the Haiku JSON", async () => {
    const callBrainRaw = async () => ({
      output: { facts: [{ text: "likes cats", entities: [{ name: "cats", type: "thing" }] }] },
      usage: { ...USAGE },
    });
    const out = await extractDurableFacts("I love my cats", DEPS, undefined, {
      callBrainRaw: callBrainRaw as unknown as typeof import("../../src/brain/brain").callBrainRaw,
      ledger: (async () => {}) as typeof ledgerBrainCall,
    });
    expect(out).toEqual([{ text: "likes cats", entities: [{ name: "cats", type: "thing" }] }]);
  });

  test("defaults missing entities to [] and drops blank text", async () => {
    const callBrainRaw = async () => ({
      output: { facts: [{ text: "no entity" }, { text: "  " }] },
      usage: { ...USAGE },
    });
    const out = await extractDurableFacts("x", DEPS, undefined, {
      callBrainRaw: callBrainRaw as unknown as typeof import("../../src/brain/brain").callBrainRaw,
      ledger: (async () => {}) as typeof ledgerBrainCall,
    });
    expect(out).toEqual([{ text: "no entity", entities: [] }]);
  });

  test("malformed output degrades to []", async () => {
    const callBrainRaw = async () => ({ output: { nope: 1 }, usage: { ...USAGE } });
    const out = await extractDurableFacts("x", DEPS, undefined, {
      callBrainRaw: callBrainRaw as unknown as typeof import("../../src/brain/brain").callBrainRaw,
      ledger: (async () => {}) as typeof ledgerBrainCall,
    });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Classification upgrade — optional 3rd param `candidates`. Absent/empty →
// EXACTLY today's behavior (rollback path); present → prompt gains a
// CANDIDATE FACTS block + classification rules, and each fact gains
// {classification, target_fact_id, confidence} with fail-open normalization
// (invalid classification → "add"). NO routing here — verdict re-derivation
// is the consolidation runner's layer-2.
// ---------------------------------------------------------------------------

/** Stub brain that records the prompt opts it was called with. */
function recordingBrain(output: unknown) {
  const calls: Array<{ systemPrompt: string; contextBundle: string }> = [];
  const fn = (async (opts: { systemPrompt: string; contextBundle: string }) => {
    calls.push({ systemPrompt: opts.systemPrompt, contextBundle: opts.contextBundle });
    return { output, usage: { ...USAGE } };
  }) as unknown as typeof callBrainRaw;
  return { fn, calls };
}

const noLedger = (async () => {}) as typeof ledgerBrainCall;
const CANDIDATES = [
  { id: "fact-1", text: "狗派" },
  { id: "fact-2", text: "用 bun 跑测试" },
];

describe("extractDurableFacts candidates (classification upgrade)", () => {
  // K1 — rollback path: no candidates → prompt has NO candidates block, NO
  // classification rules; contextBundle is the raw message (today's behavior).
  test("K1 无 candidates → prompt 不含 CANDIDATE FACTS（rollback 路径）", async () => {
    const { fn, calls } = recordingBrain({ facts: [{ text: "喜欢蛋糕", entities: [] }] });
    const result = await extractDurableFacts("我喜欢蛋糕", DEPS, undefined, {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.contextBundle).toBe("我喜欢蛋糕");
    expect(calls[0]!.systemPrompt).not.toContain("CANDIDATE FACTS");
    expect(calls[0]!.systemPrompt).not.toContain("contradict");
    // Old output shape — no classification fields.
    expect(result).toEqual([{ text: "喜欢蛋糕", entities: [] }]);
  });

  // K1b — empty candidates array behaves exactly like absent.
  test("K1b 空 candidates 数组 = 无 candidates", async () => {
    const { fn, calls } = recordingBrain({ facts: [{ text: "喜欢蛋糕", entities: [] }] });
    const result = await extractDurableFacts("我喜欢蛋糕", DEPS, [], {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    expect(calls[0]!.contextBundle).toBe("我喜欢蛋糕");
    expect(calls[0]!.systemPrompt).not.toContain("CANDIDATE FACTS");
    expect(result).toEqual([{ text: "喜欢蛋糕", entities: [] }]);
  });

  // K1c — rollback shape holds even if the model gratuitously emits
  // classification fields when none were asked for (dropped, old shape kept).
  test("K1c 无 candidates 时多余 classification 字段被丢弃", async () => {
    const { fn } = recordingBrain({
      facts: [{ text: "喜欢蛋糕", entities: [], classification: "contradict", target_fact_id: "x" }],
    });
    const result = await extractDurableFacts("我喜欢蛋糕", DEPS, undefined, {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    expect(result).toEqual([{ text: "喜欢蛋糕", entities: [] }]);
  });

  // K2 — candidates present → contextBundle carries the `- <id>: <text>` block
  // + the user message; systemPrompt carries the classification rules incl.
  // the numeric-specifics guard.
  test("K2 有 candidates → prompt 含 CANDIDATE FACTS block + 分类规则", async () => {
    const { fn, calls } = recordingBrain({ facts: [] });
    await extractDurableFacts("不对，我是猫派", DEPS, CANDIDATES, {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    const { systemPrompt, contextBundle } = calls[0]!;
    expect(contextBundle).toContain("CANDIDATE FACTS:");
    expect(contextBundle).toContain("- fact-1: 狗派");
    expect(contextBundle).toContain("- fact-2: 用 bun 跑测试");
    expect(contextBundle).toContain("USER MESSAGE:\n不对，我是猫派");
    expect(systemPrompt).toContain('"restate"');
    expect(systemPrompt).toContain('"contradict"');
    // Numeric-specifics guard sentence (adapted from NL_EDIT_SYSTEM_PROMPT).
    expect(systemPrompt).toContain("numeric values");
    expect(systemPrompt).toContain("cannot both be true");
    // Never-invent-an-id rule.
    expect(systemPrompt).toContain("Never invent an id");
  });

  // K3 — classified output parses: classification/target/confidence pass through.
  test("K3 分类输出解析成功", async () => {
    const { fn } = recordingBrain({
      facts: [
        { text: "猫派", entities: [], classification: "contradict", target_fact_id: "fact-1", confidence: 0.95 },
        { text: "喜欢深色主题", entities: [], classification: "add", target_fact_id: null, confidence: 0.8 },
      ],
    });
    const result = await extractDurableFacts("不对，我是猫派，另外我喜欢深色主题", DEPS, CANDIDATES, {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    expect(result).toEqual([
      { text: "猫派", entities: [], classification: "contradict", target_fact_id: "fact-1", confidence: 0.95 },
      { text: "喜欢深色主题", entities: [], classification: "add", target_fact_id: null, confidence: 0.8 },
    ]);
  });

  // K4 — fail-open: missing or invalid classification degrades to "add"
  // WITHOUT rejecting the fact (or the batch).
  test("K4 缺失/非法 classification → 'add'（fail-open）", async () => {
    const { fn } = recordingBrain({
      facts: [
        { text: "猫派", entities: [] }, // missing entirely
        { text: "用 pnpm", entities: [], classification: "supersede" }, // invalid enum
        { text: "住上海", entities: [], classification: 42 }, // wrong type
      ],
    });
    const result = await extractDurableFacts("x", DEPS, CANDIDATES, {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    expect(result.map((f) => f.classification)).toEqual(["add", "add", "add"]);
  });

  // K5 — invalid target/confidence normalize (null / undefined), fact kept.
  test("K5 非法 target_fact_id → null；非法 confidence → undefined", async () => {
    const { fn } = recordingBrain({
      facts: [
        { text: "猫派", entities: [], classification: "contradict", target_fact_id: 42, confidence: "high" },
        { text: "用 pnpm", entities: [], classification: "restate", target_fact_id: "fact-2", confidence: 1.5 },
      ],
    });
    const result = await extractDurableFacts("x", DEPS, CANDIDATES, {
      callBrainRaw: fn,
      ledger: noLedger,
    });
    expect(result[0]!.target_fact_id).toBeNull();
    expect(result[0]!.confidence).toBeUndefined();
    expect(result[1]!.target_fact_id).toBe("fact-2");
    // Out-of-range confidence is NOT clamped (no inflating an uncalibrated
    // score into the auto-supersede tier) — it degrades to undefined.
    expect(result[1]!.confidence).toBeUndefined();
  });

  // (K6 removed in a review-fix: it stubbed callBrainRaw to return {facts:[]}
  // and asserted [] — the stub encoded the answer, so it could never fail at
  // its checkpoint (anti-vacuous-assertion discipline). The gate-layer half of
  // "不对，13×7=91" lives in chat-capture C4; the EXTRACTOR-side behavior is
  // real-model territory and is verified by an eval set (pet-output
  // corrections category), not a unit stub.)

  // K7 — malformed WHOLE payload with candidates present still degrades to []
  // and still ledgers (same lenient discipline as the no-candidates path).
  test("K7 有 candidates 时整体 malformed → [] 且已记账", async () => {
    let ledgerCalls = 0;
    const { fn } = recordingBrain("not even an object");
    const result = await extractDurableFacts("不对，我是猫派", DEPS, CANDIDATES, {
      callBrainRaw: fn,
      ledger: (async () => {
        ledgerCalls += 1;
      }) as typeof ledgerBrainCall,
    });
    expect(result).toEqual([]);
    expect(ledgerCalls).toBe(1);
  });
});
