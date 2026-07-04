// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainUsage } from "../../src/brain/brain";
import {
  addOnlyRecall,
  type ChatCorrectionCase,
  checkPaidGate,
  DEFAULT_CASES_PATH,
  deriveWrite,
  loadCases,
  recommendThresholds,
  runChatCorrectionEval,
  type ScoredCase,
  scoreCase,
  sweepThresholds,
  thresholdGrid,
} from "../../src/eval/chat-correction-eval";
import type { ExtractedFact } from "../../src/memory/extract-facts";

const usage: BrainUsage = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.01,
};

function makeCase(
  id: string,
  expectedFacts: ChatCorrectionCase["expected"]["facts"],
  should_write: ChatCorrectionCase["expected"]["should_write"],
  category = "test",
): ChatCorrectionCase {
  return {
    id,
    message: `msg-${id}`,
    candidates: [
      { id: "f-01", text: "candidate one" },
      { id: "f-02", text: "candidate two" },
    ],
    expected: { facts: expectedFacts, should_write },
    category,
    lang: "en",
  };
}

function fact(
  classification: "add" | "restate" | "contradict",
  target: string | null,
  confidence?: number,
): ExtractedFact {
  return { text: "t", entities: [], classification, target_fact_id: target, confidence };
}

// Tiny synthetic 4-case set exercising the scoring math end-to-end:
//  s1: true correction, classified right (conf .95)      → correct replace
//  s2: true correction, model targeted the WRONG fact    → fired replace, incorrect
//  s3: numeric trap, model wrongly said contradict @ .6  → drop at (.9,.7), replace at low pairs
//  s4: plain add, classified add                         → positive control
function tinyScoredSet(): ScoredCase[] {
  const c1 = makeCase("s1", [{ classification: "contradict", target_id: "f-01" }], "replace");
  const c2 = makeCase("s2", [{ classification: "contradict", target_id: "f-01" }], "replace");
  const c3 = makeCase("s3", [{ classification: "add", target_id: null }], "add", "numeric-trap");
  const c4 = makeCase("s4", [{ classification: "add", target_id: null }], "add", "plain-add");
  return [
    { evalCase: c1, result: scoreCase(c1, [fact("contradict", "f-01", 0.95)]) },
    { evalCase: c2, result: scoreCase(c2, [fact("contradict", "f-02", 0.95)]) },
    { evalCase: c3, result: scoreCase(c3, [fact("contradict", "f-01", 0.6)]) },
    { evalCase: c4, result: scoreCase(c4, [fact("add", null)]) },
  ];
}

describe("scoreCase", () => {
  test("correct contradict matches classification and target", () => {
    const [s1] = tinyScoredSet();
    expect(s1!.result.classification_match).toBe(true);
    expect(s1!.result.target_match).toBe(true);
  });

  test("wrong target: classification matches, target does not", () => {
    const s2 = tinyScoredSet()[1]!;
    expect(s2.result.classification_match).toBe(true);
    expect(s2.result.target_match).toBe(false);
  });

  test("numeric trap misclassified as contradict fails classification match", () => {
    const s3 = tinyScoredSet()[2]!;
    expect(s3.result.classification_match).toBe(false);
  });

  test("layer-2 mirror: phantom target downgrades to add (never phantom-supersede)", () => {
    const c = makeCase("p1", [{ classification: "add", target_id: null }], "add");
    const r = scoreCase(c, [fact("contradict", "f-99", 0.95)]);
    expect(r.verdicts[0]!.classification).toBe("add");
    expect(r.verdicts[0]!.target_id).toBeNull();
    expect(r.classification_match).toBe(true);
    expect(r.target_match).toBe(true);
  });

  test("layer-2 mirror: numeric-equivalent contradict downgrades to add (guard parity with the runner)", () => {
    // Real eval pair (nt-zh-01): claim "有 3 只猫" vs candidate "用户养了 2 只猫"
    // at contradict@0.95 — above every T_HIGH, so only the code guard fixes it.
    const c: ChatCorrectionCase = {
      id: "nt",
      message: "我有 3 只猫",
      candidates: [{ id: "f-01", text: "用户养了 2 只猫" }],
      expected: { facts: [{ classification: "add", target_id: null }], should_write: "add" },
      category: "numeric-trap",
      lang: "zh",
    };
    const r = scoreCase(c, [
      {
        text: "有 3 只猫",
        entities: [],
        classification: "contradict",
        target_fact_id: "f-01",
        confidence: 0.95,
      },
    ]);
    expect(r.verdicts[0]!.classification).toBe("add");
    expect(r.verdicts[0]!.target_id).toBeNull();
    expect(r.classification_match).toBe(true);
    expect(r.target_match).toBe(true);
  });

  test("layer-2 mirror: numeric guard falls back to the MESSAGE when the claim was translated (eval nt-en-01)", () => {
    // Real eval shape: English message, but the extractor emitted a CHINESE
    // claim — claim-vs-candidate shares no grams, only the message preserves
    // the numeric-equivalent surface.
    const c: ChatCorrectionCase = {
      id: "nt-x",
      message: "I have 3 monitors on my desk",
      candidates: [{ id: "f-01", text: "User has 2 monitors" }],
      expected: { facts: [{ classification: "add", target_id: null }], should_write: "add" },
      category: "numeric-trap",
      lang: "en",
    };
    const r = scoreCase(c, [
      {
        text: "有 3 个监视器在桌子上",
        entities: [],
        classification: "contradict",
        target_fact_id: "f-01",
        confidence: 0.95,
      },
    ]);
    expect(r.verdicts[0]!.classification).toBe("add");
    expect(r.classification_match).toBe(true);
  });

  test("pet-output: no facts expected, no facts emitted → match", () => {
    const c = makeCase("po", [], "none", "pet-output");
    const r = scoreCase(c, []);
    expect(r.classification_match).toBe(true);
    expect(r.target_match).toBe(true);
  });
});

describe("deriveWrite ladder", () => {
  const v = (confidence?: number) => ({
    text: "t",
    classification: "contradict" as const,
    target_id: "f-01",
    confidence,
  });
  test("ladder tiers from the number, never a boolean", () => {
    expect(deriveWrite(v(0.95), 0.9, 0.7)).toBe("replace");
    expect(deriveWrite(v(0.8), 0.9, 0.7)).toBe("propose");
    expect(deriveWrite(v(0.5), 0.9, 0.7)).toBe("none");
  });
  test("undefined confidence → propose (runner's conservative belt)", () => {
    expect(deriveWrite(v(undefined), 0.9, 0.7)).toBe("propose");
  });
  test("add and restate bypass the ladder", () => {
    expect(deriveWrite({ text: "t", classification: "add", target_id: null }, 0.9, 0.7)).toBe("add");
    expect(deriveWrite({ text: "t", classification: "restate", target_id: "f-01" }, 0.9, 0.7)).toBe(
      "none",
    );
  });
});

describe("sweepThresholds", () => {
  test("grid is the 45-pair T_MID < T_HIGH cross product", () => {
    expect(thresholdGrid()).toHaveLength(45);
    expect(sweepThresholds(tinyScoredSet())).toHaveLength(45);
  });

  test("at (0.9, 0.7): s1+s2 fire, only s1 correct → precision 0.5, recall 0.5", () => {
    const rows = sweepThresholds(tinyScoredSet());
    const row = rows.find((r) => r.t_high === 0.9 && r.t_mid === 0.7)!;
    expect(row.replace_fired).toBe(2);
    expect(row.replace_correct).toBe(1);
    expect(row.auto_precision).toBe(0.5);
    expect(row.auto_recall).toBe(0.5);
    expect(row.mid_band).toBe(0); // s3's 0.6 is below T_MID 0.7 → dropped
  });

  test("at (0.55, 0.5): the numeric trap also fires → precision drops to 1/3", () => {
    const rows = sweepThresholds(tinyScoredSet());
    const row = rows.find((r) => r.t_high === 0.55 && r.t_mid === 0.5)!;
    expect(row.replace_fired).toBe(3);
    expect(row.auto_precision).toBeCloseTo(1 / 3);
  });

  test("at (0.7, 0.6): trap's 0.6 lands the mid-band", () => {
    const rows = sweepThresholds(tinyScoredSet());
    const row = rows.find((r) => r.t_high === 0.7 && r.t_mid === 0.6)!;
    expect(row.mid_band).toBe(1);
  });

  test("addOnlyRecall over plain-add category", () => {
    expect(addOnlyRecall(tinyScoredSet())).toBe(1);
  });
});

describe("recommendThresholds", () => {
  test("picks highest precision, ties broken to the most conservative pair", () => {
    const rows = sweepThresholds(tinyScoredSet());
    const rec = recommendThresholds(rows)!;
    // Max precision is 0.5 (recall 0.5 ≥ floor); conservative tie-break → top of grid.
    expect(rec.auto_precision).toBe(0.5);
    expect(rec.t_high).toBe(0.95);
    expect(rec.t_mid).toBe(0.9);
  });

  test("returns null when nothing ever fires correctly (contingency path)", () => {
    const c = makeCase("z1", [{ classification: "add", target_id: null }], "add");
    const scored: ScoredCase[] = [{ evalCase: c, result: scoreCase(c, [fact("add", null)]) }];
    expect(recommendThresholds(sweepThresholds(scored))).toBeNull();
  });
});

describe("runChatCorrectionEval replay mode", () => {
  const caseLine = (id: string, message: string) =>
    JSON.stringify({
      id,
      message,
      candidates: [{ id: "f-01", text: "用户是狗派" }],
      expected: { facts: [{ classification: "contradict", target_id: "f-01" }], should_write: "replace" },
      category: "correction-explicit",
      lang: "zh",
    });
  const responseLine = (id: string) =>
    JSON.stringify({
      id,
      output: {
        facts: [
          {
            text: "用户是猫派",
            entities: [],
            classification: "contradict",
            target_fact_id: "f-01",
            confidence: 0.92,
          },
        ],
      },
      usage,
    });

  test("replays from the cache without touching the Brain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-corr-eval-"));
    const casesPath = join(dir, "cases.jsonl");
    const cachePath = join(dir, "responses.jsonl");
    await writeFile(casesPath, `${caseLine("c1", "不对，我是猫派")}\n${caseLine("c2", "我现在是猫派了")}\n`);
    await writeFile(cachePath, `${responseLine("c1")}\n${responseLine("c2")}\n`);

    const run = await runChatCorrectionEval({
      casesPath,
      cachePath,
      paid: false,
      callBrainRaw: async () => {
        throw new Error("real Brain must NOT be called in replay mode");
      },
    });

    expect(run.scored).toHaveLength(2);
    expect(run.scored[0]!.result.classification_match).toBe(true);
    expect(run.scored[0]!.result.target_match).toBe(true);
    expect(run.totalCostUsd).toBeCloseTo(0.02);
    expect(run.failedIds).toHaveLength(0);
    expect(run.report).toContain("Threshold sweep");
    // conf 0.92 → replaces fire up to T_HIGH 0.9, 2/2 correct
    const row = run.sweep.find((r) => r.t_high === 0.9 && r.t_mid === 0.7)!;
    expect(row.auto_precision).toBe(1);
    expect(row.auto_recall).toBe(1);
  });

  test("missing cache in $0 mode fails gracefully, pointing at --paid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-corr-eval-"));
    const casesPath = join(dir, "cases.jsonl");
    const cachePath = join(dir, "responses.jsonl");
    await writeFile(casesPath, `${caseLine("c1", "不对，我是猫派")}\n${caseLine("c2", "我现在是猫派了")}\n`);
    await writeFile(cachePath, `${responseLine("c1")}\n`); // c2 missing

    await expect(
      runChatCorrectionEval({ casesPath, cachePath, paid: false }),
    ).rejects.toThrow(/missing 1\/2.*--paid/s);
  });

  test("loadCases is loud on a malformed labeled line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-corr-eval-"));
    const casesPath = join(dir, "cases.jsonl");
    await writeFile(casesPath, `${caseLine("c1", "x")}\n{"id":"broken"}\n`);
    await expect(loadCases(casesPath)).rejects.toThrow(/:2: invalid case shape/);
  });
});

describe("checkPaidGate", () => {
  test("refuses without SILTPOKE_EVAL_PAID=1 and prints the projection", () => {
    const gate = checkPaidGate(50, {});
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("50 cases");
    expect(gate.reason).toContain("$2.50");
    expect(gate.reason).toContain("SILTPOKE_EVAL_PAID=1");
  });

  test("passes with the env belt set", () => {
    expect(checkPaidGate(50, { SILTPOKE_EVAL_PAID: "1" }).ok).toBe(true);
  });
});

describe("shipped labeled set integrity", () => {
  test("~50 valid cases, unique ids, targets always inside the candidate list", async () => {
    const cases = await loadCases(DEFAULT_CASES_PATH);
    expect(cases.length).toBeGreaterThanOrEqual(45);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      const ids = new Set(c.candidates.map((x) => x.id));
      for (const f of c.expected.facts) {
        if (f.target_id !== null) expect(ids.has(f.target_id)).toBe(true);
        if (f.classification === "add") expect(f.target_id).toBeNull();
      }
      if (c.expected.should_write === "replace") {
        expect(c.expected.facts.some((f) => f.classification === "contradict")).toBe(true);
      }
      if (c.category === "pet-output") expect(c.expected.facts).toHaveLength(0);
    }
    // positive control present
    expect(cases.filter((c) => c.category === "plain-add").length).toBeGreaterThanOrEqual(8);
  });
});
