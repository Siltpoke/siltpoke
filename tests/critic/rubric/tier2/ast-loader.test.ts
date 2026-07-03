import { describe, test, expect } from "bun:test";
import { parseSource, getLanguage } from "../../../../src/critic/rubric/tier2/ast-loader";

describe("ast-loader", () => {
  test("parses TS source returns Tree node", async () => {
    const tree = await parseSource("const x = 1;", "ts");
    expect(tree).toBeTruthy();
    expect(tree?.rootNode.type).toBe("program");
  });

  test("parses Python source", async () => {
    const tree = await parseSource("def foo():\n    return 1", "py");
    expect(tree?.rootNode.type).toBe("module");
  });

  test("getLanguage('ts') === getLanguage('ts') (cached)", async () => {
    const a = await getLanguage("ts");
    const b = await getLanguage("ts");
    expect(a).toBe(b);
  });

  test("unknown ext → null", async () => {
    const tree = await parseSource("x", "rb" as never);
    expect(tree).toBeNull();
  });
});
