/**
 * unit test for the repoGraph island's pure
 * coupling-tier helper. Rebuilt after a render-layer rewrite removed the
 * previous unit test, now asserting the PROTOTYPE thresholds (app.js
 * `showEdgeTip`): >15 = heavy coupling (terra/strong edge), >=8 = moderate,
 * else light. The boundaries double as the strong-edge styling contract
 * (`elink.strong` ⇔ w > 15), so they regress loudly if anyone re-tunes them.
 */
import { test, expect, describe } from "bun:test";
import { couplingTier, symTraceAffordance, decodeCanonicalNodeId } from "../../../src/web/client/islands/repo-graph";

describe("couplingTier (edge-tooltip coupling wording, prototype thresholds)", () => {
  test("1–7 imports → light", () => {
    expect(couplingTier(1)).toBe("light");
    expect(couplingTier(7)).toBe("light");
  });

  test("8–15 imports → moderate", () => {
    expect(couplingTier(8)).toBe("moderate");
    expect(couplingTier(15)).toBe("moderate");
  });

  test(">15 imports → heavy coupling (matches strong-edge threshold w > 15)", () => {
    expect(couplingTier(16)).toBe("heavy coupling");
    expect(couplingTier(50)).toBe("heavy coupling");
  });
});

describe("symTraceAffordance (C4 — honest trace affordance, no silent gap)", () => {
  test("function symbol with a resolved path → working button", () => {
    expect(
      symTraceAffordance({ kind: "symbol", getTarget: "function:src/a.ts:foo", symKind: "function" }),
    ).toBe("button");
  });

  test("function symbol whose path didn't resolve (getTarget='') → honest inert note", () => {
    expect(
      symTraceAffordance({ kind: "symbol", getTarget: "", symKind: "function" }),
    ).toBe("note");
  });

  test("non-function symbol (class, etc.) → no affordance", () => {
    expect(
      symTraceAffordance({ kind: "symbol", getTarget: "", symKind: "class" }),
    ).toBe("none");
    // a resolved class getTarget is never "function:" so it also yields none
    expect(
      symTraceAffordance({ kind: "symbol", getTarget: "class:src/a.ts:Foo", symKind: "class" }),
    ).toBe("none");
  });

  test("file foot (not a symbol) → no affordance", () => {
    expect(
      symTraceAffordance({ kind: "file", getTarget: "file:src/a.ts:" }),
    ).toBe("none");
  });

  test("symbol scope with symKind omitted → no affordance (no-symKind = no note)", () => {
    expect(symTraceAffordance({ kind: "symbol", getTarget: "" })).toBe("none");
  });
});

/**
 * Non-vacuous tests for decodeCanonicalNodeId.
 *
 * These tests would FAIL without the fix (the function did not exist before).
 * They are grounded against the extractor.ts `nodeId` function:
 *   nodeId(type, relPath, name) → `${type}:${relPath}:${name}`
 *   file nodes: `file:${relPath}:` (empty name)
 *
 * Non-vacuousness proof: these tests import and call `decodeCanonicalNodeId`
 * directly — they do NOT go through a fakeBridge that ignores its arg. If the
 * function returned null for canonical ids (the old behavior — function didn't
 * exist), every "returns descriptor" assertion would fail.
 */
describe("decodeCanonicalNodeId (canonical node_id → descriptor)", () => {
  test("function node id → {node_type:'function', path, name}", () => {
    expect(decodeCanonicalNodeId("function:src/foo.ts:applyDiscount")).toEqual({
      node_type: "function",
      path: "src/foo.ts",
      name: "applyDiscount",
    });
  });

  test("file node id (empty name) → {node_type:'file', path, name:''}", () => {
    expect(decodeCanonicalNodeId("file:src/foo.ts:")).toEqual({
      node_type: "file",
      path: "src/foo.ts",
      name: "",
    });
  });

  test("class node id → {node_type:'class', path, name}", () => {
    expect(decodeCanonicalNodeId("class:src/models/User.ts:UserModel")).toEqual({
      node_type: "class",
      path: "src/models/User.ts",
      name: "UserModel",
    });
  });

  test("deeper path (multiple slashes) → path is preserved intact", () => {
    expect(decodeCanonicalNodeId("function:src/web/client/islands/repo-graph.ts:couplingTier")).toEqual({
      node_type: "function",
      path: "src/web/client/islands/repo-graph.ts",
      name: "couplingTier",
    });
  });

  test("unknown / ad-hoc id (no canonical prefix) → null", () => {
    expect(decodeCanonicalNodeId("some-random-trace-id")).toBeNull();
  });

  test("empty string → null", () => {
    expect(decodeCanonicalNodeId("")).toBeNull();
  });

  test("'fn' alias → decoded (fn is a valid canonical type alias)", () => {
    expect(decodeCanonicalNodeId("fn:src/utils.ts:helper")).toEqual({
      node_type: "fn",
      path: "src/utils.ts",
      name: "helper",
    });
  });
});
