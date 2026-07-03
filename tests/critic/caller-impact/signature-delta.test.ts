import { describe, expect, test } from "bun:test";
import {
  extractParamProfile,
  signatureDelta,
} from "../../../src/critic/caller-impact/signature-delta.ts";

// signature-delta is "the gate": a caller-impact block is
// emitted ONLY when a function's signature changed. The delta is scoped to
// param-count + required/optional arity (return-type deferred). These tests
// assert OBSERVABLE behavior so the real tree-sitter grammar drives the
// classification, not memorized node-type names.

describe("signatureDelta", () => {
  test("param count 2→3 ⇒ changed", async () => {
    const d = await signatureDelta(
      "function f(a: number, b: number) { return a; }",
      "function f(a: number, b: number, c: number) { return a; }",
      "ts",
    );
    expect(d).toEqual({ changed: true, skipped: false });
  });

  test("required → optional via `?` ⇒ changed (same count)", async () => {
    const d = await signatureDelta(
      "function f(a: number) {}",
      "function f(a?: number) {}",
      "ts",
    );
    expect(d).toEqual({ changed: true, skipped: false });
  });

  test("required → optional via default value ⇒ changed (same count)", async () => {
    const d = await signatureDelta(
      "function f(a: number) {}",
      "function f(a: number = 1) {}",
      "ts",
    );
    expect(d).toEqual({ changed: true, skipped: false });
  });

  test("body-only edit ⇒ not changed", async () => {
    const d = await signatureDelta(
      "function f(a: number, b: number) { return 1; }",
      "function f(a: number, b: number) { return 2; }",
      "ts",
    );
    expect(d).toEqual({ changed: false, skipped: false });
  });

  test("param rename only (count + arity unchanged) ⇒ not changed", async () => {
    // Positional callers don't break on a param rename — OQ2 is count+arity only.
    const d = await signatureDelta(
      "function f(a: number) {}",
      "function f(b: number) {}",
      "ts",
    );
    expect(d).toEqual({ changed: false, skipped: false });
  });

  test("arrow function param count change ⇒ changed", async () => {
    const d = await signatureDelta(
      "const f = (a: number) => a;",
      "const f = (a: number, b: number) => a + b;",
      "ts",
    );
    expect(d).toEqual({ changed: true, skipped: false });
  });

  test("explicit `this` param is caller-invisible ⇒ not changed", async () => {
    // `this: T` is a TS type-only annotation; call sites never pass it.
    const d = await signatureDelta(
      "function f(this: void, a: string) {}",
      "function f(a: string) {}",
      "ts",
    );
    expect(d).toEqual({ changed: false, skipped: false });
  });

  test("bare unparenthesized arrow param count change ⇒ changed", async () => {
    const d = await signatureDelta(
      "const f = x => x;",
      "const f = (x, y) => x + y;",
      "ts",
    );
    expect(d).toEqual({ changed: true, skipped: false });
  });

  test("unparseable / non-TS after-image ⇒ skipped, no delta", async () => {
    // Contingency: parse failure → emit no block (skip), never whole-file fallback.
    const d = await signatureDelta(
      "function f(a: number) {}",
      "@@@ this is not valid typescript @@@ {{{",
      "ts",
    );
    expect(d).toEqual({ changed: false, skipped: true });
  });

  test("empty before-image (no prior signature) ⇒ skipped", async () => {
    const d = await signatureDelta("", "function f(a: number) {}", "ts");
    expect(d).toEqual({ changed: false, skipped: true });
  });
});

describe("extractParamProfile", () => {
  test("classifies required vs optional (`?`) params", async () => {
    const p = await extractParamProfile(
      "function f(a: number, b?: string) {}",
      "ts",
    );
    expect(p).toEqual({ count: 2, required: 1, optional: 1 });
  });

  test("default-valued param counts as optional", async () => {
    const p = await extractParamProfile("function f(a = 1) {}", "ts");
    expect(p).toEqual({ count: 1, required: 0, optional: 1 });
  });

  test("rest param counts as optional", async () => {
    const p = await extractParamProfile(
      "function f(...args: number[]) {}",
      "ts",
    );
    expect(p).toEqual({ count: 1, required: 0, optional: 1 });
  });

  test("no params ⇒ zeroed profile", async () => {
    const p = await extractParamProfile("function f() {}", "ts");
    expect(p).toEqual({ count: 0, required: 0, optional: 0 });
  });

  test("bare unparenthesized arrow ⇒ one required param", async () => {
    const p = await extractParamProfile("const f = x => x;", "ts");
    expect(p).toEqual({ count: 1, required: 1, optional: 0 });
  });

  test("`this` param excluded from profile", async () => {
    const p = await extractParamProfile(
      "function f(this: void, a: string) {}",
      "ts",
    );
    expect(p).toEqual({ count: 1, required: 1, optional: 0 });
  });

  test("parse failure ⇒ null", async () => {
    const p = await extractParamProfile("@@@ not code", "ts");
    expect(p).toBeNull();
  });
});
