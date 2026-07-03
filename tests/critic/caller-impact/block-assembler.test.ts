import { describe, expect, test } from "bun:test";
import { assembleCallerBlock } from "../../../src/critic/caller-impact/block-assembler.ts";
import type { CallerRef, CallerSet } from "../../../src/critic/caller-impact/caller-resolver.ts";

// The block assembler is where multiple gating rules converge. Tests assert
// the observable block text + the discrete quotable tokens.

function callerSet(callers: CallerRef[], over: Partial<CallerSet> = {}): CallerSet {
  return {
    callers,
    defs: 1,
    ambiguous: false,
    callsiteCount: callers.length,
    unavailable: false,
    ...over,
  };
}

describe("assembleCallerBlock — gating", () => {
  test("modified + signature unchanged ⇒ no block", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "modified",
      signatureChanged: false,
      callers: callerSet([{ file: "a.ts", line: 10 }]),
    });
    expect(block).toBeNull();
  });

  test("added function ⇒ no block (never fabricate callers)", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "added",
      signatureChanged: true,
      callers: callerSet([{ file: "a.ts", line: 10 }]),
    });
    expect(block).toBeNull();
  });

  test("resolver unavailable ⇒ no block", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "modified",
      signatureChanged: true,
      callers: callerSet([], { unavailable: true, callsiteCount: 0 }),
    });
    expect(block).toBeNull();
  });

  test("modified + sig changed but zero callers ⇒ no block", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "modified",
      signatureChanged: true,
      callers: callerSet([]),
    });
    expect(block).toBeNull();
  });
});

describe("assembleCallerBlock — content", () => {
  test("modified + sig changed ⇒ header + discrete caller tokens", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "modified",
      signatureChanged: true,
      callers: callerSet([
        { file: "a.ts", line: 10 },
        { file: "b.ts", line: 3 },
      ]),
    });
    expect(block).not.toBeNull();
    expect(block?.tokens).toEqual(["caller: a.ts:10", "caller: b.ts:3"]);
    expect(block?.text).toContain("`foo` signature changed");
    expect(block?.text).toContain("caller: a.ts:10");
    expect(block?.text).toContain("caller: b.ts:3");
    expect(block?.truncated).toBe(false);
  });

  test("removed function with refs ⇒ orphan warning", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "removed",
      signatureChanged: false,
      callers: callerSet([{ file: "a.ts", line: 10 }]),
    });
    expect(block?.text).toContain("you removed `foo` but these still reference it");
    expect(block?.tokens).toEqual(["caller: a.ts:10"]);
  });

  test("ambiguous ⇒ downgraded label, NO caller list", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "modified",
      signatureChanged: true,
      callers: callerSet([{ file: "a.ts", line: 10 }], {
        ambiguous: true,
        defs: 3,
        callsiteCount: 5,
      }),
    });
    expect(block?.text).toContain("ambiguous");
    expect(block?.text).toContain("5 callsite");
    expect(block?.text).not.toContain("caller: a.ts:10");
    expect(block?.tokens.some((t) => t.startsWith("caller:"))).toBe(false);
  });
});

describe("assembleCallerBlock — bounding", () => {
  test("more callers than capLines ⇒ +N more, capped list", () => {
    const many: CallerRef[] = Array.from({ length: 30 }, (_, i) => ({
      file: `f${i}.ts`,
      line: i + 1,
    }));
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "modified",
      signatureChanged: true,
      callers: callerSet(many),
      capLines: 5,
    });
    expect(block?.truncated).toBe(true);
    expect(block?.tokens).toHaveLength(5);
    expect(block?.text).toContain("+25 more");
  });

  test("token budget binds: a bigger budget keeps strictly more callers", () => {
    // Non-circular proof the budget arithmetic actually drives the count (not a
    // constant "always keep 1"): same callers, two budgets, monotonic result.
    const many: CallerRef[] = Array.from({ length: 30 }, (_, i) => ({
      file: `some/longer/path/file-${i}.ts`,
      line: i + 100,
    }));
    const base = {
      functionName: "foo",
      kind: "modified" as const,
      signatureChanged: true,
      callers: callerSet(many),
      capLines: 100, // keep the LINE cap out of the way; only the budget binds
    };
    const small = assembleCallerBlock({ ...base, tokenBudget: 60 });
    const large = assembleCallerBlock({ ...base, tokenBudget: 200 });
    expect(small?.truncated).toBe(true);
    expect(large?.truncated).toBe(true);
    expect(small?.tokens.length).toBeGreaterThan(0);
    expect(large?.tokens.length).toBeGreaterThan(small?.tokens.length ?? 0);
    expect(large?.tokens.length).toBeLessThan(30);
    // +N more arithmetic is exact for whatever count the budget allowed.
    expect(small?.text).toContain(`+${30 - (small?.tokens.length ?? 0)} more`);
  });
});

describe("assembleCallerBlock — removed-kind edge cases", () => {
  test("removed + ambiguous ⇒ downgraded label, no caller list", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "removed",
      signatureChanged: false,
      callers: callerSet([{ file: "a.ts", line: 10 }], {
        ambiguous: true,
        defs: 2,
        callsiteCount: 4,
      }),
    });
    expect(block?.text).toContain("ambiguous");
    expect(block?.text).not.toContain("you removed");
    expect(block?.tokens.some((t) => t.startsWith("caller:"))).toBe(false);
  });

  test("removed + zero callers ⇒ no block", () => {
    const block = assembleCallerBlock({
      functionName: "foo",
      kind: "removed",
      signatureChanged: false,
      callers: callerSet([]),
    });
    expect(block).toBeNull();
  });
});
