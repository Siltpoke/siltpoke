/**
 * AST signature tests.
 */
import { test, expect, describe } from "bun:test";
import { computeAstSignature } from "../../src/repo-graph/ast-signature";
import { parseSource } from "../../src/critic/rubric/tier2/ast-loader";
import { computeContentSha, computeFingerprint, fingerprintMatches } from "../../src/repo-graph/fingerprint";

describe("ast-signature", () => {
  test("same code → same signature", async () => {
    const code = `export function foo() { return 1 + 2; }`;
    const t1 = await parseSource(code, "ts");
    const t2 = await parseSource(code, "ts");
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(computeAstSignature(t1!)).toBe(computeAstSignature(t2!));
  });

  test("whitespace-only change → same signature", async () => {
    const a = `export function foo() { return 1; }`;
    const b = `export function foo() {\n  return 1;\n}`;
    const t1 = await parseSource(a, "ts");
    const t2 = await parseSource(b, "ts");
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(computeAstSignature(t1!)).toBe(computeAstSignature(t2!));
  });

  test("structural change (added function) → different signature", async () => {
    const a = `export function foo() { return 1; }`;
    const b = `export function foo() { return 1; }\nexport function bar() { return 2; }`;
    const t1 = await parseSource(a, "ts");
    const t2 = await parseSource(b, "ts");
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(computeAstSignature(t1!)).not.toBe(computeAstSignature(t2!));
  });

  test("signature is 8 hex chars", async () => {
    const t = await parseSource(`const x = 1;`, "ts");
    expect(t).not.toBeNull();
    const sig = computeAstSignature(t!);
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("fingerprint", () => {
  test("computeContentSha is stable + 64 hex chars", () => {
    const a = computeContentSha("hello");
    const b = computeContentSha("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentSha("world")).not.toBe(a);
  });

  test("computeFingerprint combines sha + ast_sig", async () => {
    const code = `const x = 1;`;
    const tree = await parseSource(code, "ts");
    expect(tree).not.toBeNull();
    const fp = computeFingerprint(code, tree!);
    expect(fp.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.ast_sig).toMatch(/^[0-9a-f]{8}$/);
  });

  test("fingerprintMatches: identical → true", async () => {
    const code = `const x = 1;`;
    const tree = await parseSource(code, "ts");
    const a = computeFingerprint(code, tree!);
    const b = computeFingerprint(code, tree!);
    expect(fingerprintMatches(a, b)).toBe(true);
  });

  test("fingerprintMatches: different content → false", async () => {
    const treeA = await parseSource(`const x = 1;`, "ts");
    const treeB = await parseSource(`const y = 2;`, "ts");
    const a = computeFingerprint(`const x = 1;`, treeA!);
    const b = computeFingerprint(`const y = 2;`, treeB!);
    expect(fingerprintMatches(a, b)).toBe(false);
  });
});
