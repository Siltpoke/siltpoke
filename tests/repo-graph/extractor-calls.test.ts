/**
 * extractor call-edge + signature-return + doc capture.
 *
 * The initial index left `calls` edges empty; this layer populates RAW call edges (caller fn
 * node → callee name, with a static/dynamic kind) at extraction time. Also
 * captures return types into the signature and the leading JSDoc into node.doc
 * so the trace layer can show Input/Output/Purpose without re-reading source.
 */
import { test, expect, describe } from "bun:test";
import { parseSource } from "../../src/critic/rubric/tier2/ast-loader";
import { extractFile } from "../../src/repo-graph/extractor";
import type { SupportedLang } from "../../src/critic/rubric/tier2/ast-loader";

async function runExtract(code: string, lang: SupportedLang, relPath = `src/sample.${lang}`) {
  const tree = await parseSource(code, lang);
  if (!tree) throw new Error(`parse failed for lang=${lang}`);
  return extractFile(tree, { relPath, lang, lineCount: code.split("\n").length });
}

describe("extractor — call edges", () => {
  test("emits calls edges from caller fn → callee name (static)", async () => {
    const code = `
export function handleStopHook(event) {
  packContext(event);
  evaluateBudget();
}
`;
    const { edges } = await runExtract(code, "ts");
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls.map((e) => e.target).sort()).toEqual(["evaluateBudget", "packContext"]);
    for (const e of calls) {
      expect(e.source).toBe("function:src/sample.ts:handleStopHook");
      expect(e.call_kind).toBe("static");
    }
  });

  test("dedupes repeated call sites and bumps weight", async () => {
    const code = `
function a() {
  log();
  log();
  log();
}
`;
    const { edges } = await runExtract(code, "ts");
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe("log");
    expect(calls[0]?.weight).toBe(3);
  });

  test("member call uses the property name (static)", async () => {
    const code = `function a() { store.save(); }`;
    const { edges } = await runExtract(code, "ts");
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe("save");
    expect(calls[0]?.call_kind).toBe("static");
  });

  test("computed/dynamic call → dynamic kind, empty target", async () => {
    const code = `function a(fns, i) { fns[i](); }`;
    const { edges } = await runExtract(code, "ts");
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call_kind).toBe("dynamic");
    expect(calls[0]?.target).toBe("");
  });

  test("nested function attributes calls to the innermost function", async () => {
    const code = `
function outer() {
  outerCall();
  function inner() {
    innerCall();
  }
}
`;
    const { edges } = await runExtract(code, "ts");
    const calls = edges.filter((e) => e.type === "calls");
    const byTarget = new Map(calls.map((e) => [e.target, e.source]));
    expect(byTarget.get("outerCall")).toBe("function:src/sample.ts:outer");
    expect(byTarget.get("innerCall")).toBe("function:src/sample.ts:inner");
  });

  test("module-level call attributes to the file node", async () => {
    const code = `bootstrap();`;
    const { edges } = await runExtract(code, "ts");
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("file:src/sample.ts:");
    expect(calls[0]?.target).toBe("bootstrap");
  });

  test("python: emits calls from def + attribute calls", async () => {
    const code = `
def handle(event):
    pack(event)
    store.save()
`;
    const { edges } = await runExtract(code, "py");
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls.map((e) => e.target).sort()).toEqual(["pack", "save"]);
  });
});

describe("extractor — signature return type", () => {
  test("appends return type to the signature (ts)", async () => {
    const code = `export function foo(a: number): string { return ""; }`;
    const { nodes } = await runExtract(code, "ts");
    const foo = nodes.find((n) => n.name === "foo");
    expect(foo?.signature).toBe("foo(a: number): string");
  });

  test("no return type → params-only signature unchanged", async () => {
    const code = `function bar(x) { return x; }`;
    const { nodes } = await runExtract(code, "ts");
    const bar = nodes.find((n) => n.name === "bar");
    expect(bar?.signature).toBe("bar(x)");
  });
});

describe("extractor — leading doc capture", () => {
  test("captures the first descriptive line of a leading JSDoc on an exported fn", async () => {
    const code = `/** Packs the transcript into context. */
export function packContext(o) { return o; }`;
    const { nodes } = await runExtract(code, "ts");
    const fn = nodes.find((n) => n.name === "packContext");
    expect(fn?.doc).toBe("Packs the transcript into context.");
  });

  test("no doc-comment → node.doc undefined", async () => {
    const code = `export function bare() {}`;
    const { nodes } = await runExtract(code, "ts");
    const fn = nodes.find((n) => n.name === "bare");
    expect(fn?.doc).toBeUndefined();
  });

  test("captures multi-line JSDoc first descriptive line, skipping tags", async () => {
    const code = `/**
 * Atomically writes the pet state.
 * @param base the storage dir
 */
function writeState(base, state) {}`;
    const { nodes } = await runExtract(code, "ts");
    const fn = nodes.find((n) => n.name === "writeState");
    expect(fn?.doc).toBe("Atomically writes the pet state.");
  });
});
