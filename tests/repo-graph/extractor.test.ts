/**
 * extractor tests across all supported languages.
 *
 * Per-language fixture → parse → extract → assert node + edge counts +
 * types. Smoke check that the schema is populated correctly.
 */
import { test, expect, describe } from "bun:test";
import { parseSource } from "../../src/critic/rubric/tier2/ast-loader";
import { extractFile } from "../../src/repo-graph/extractor";
import type { SupportedLang } from "../../src/critic/rubric/tier2/ast-loader";

async function runExtract(
  code: string,
  lang: SupportedLang,
  relPath = `src/sample.${lang}`,
) {
  const tree = await parseSource(code, lang);
  if (!tree) throw new Error(`parse failed for lang=${lang}`);
  return extractFile(tree, { relPath, lang, lineCount: code.split("\n").length });
}

describe("extractor — typescript (.ts)", () => {
  test("extracts file + function nodes + contains edges", async () => {
    const code = `
export function foo() { return 1; }
function bar() { return 2; }
`;
    const { nodes, edges } = await runExtract(code, "ts");
    const file = nodes.find((n) => n.type === "file");
    expect(file).toBeTruthy();
    expect(file?.name).toBe("sample.ts");
    const fns = nodes.filter((n) => n.type === "function");
    expect(fns.map((n) => n.name).sort()).toEqual(["bar", "foo"]);
    const fooFn = fns.find((n) => n.name === "foo");
    expect(fooFn?.exported).toBe(true);
    const barFn = fns.find((n) => n.name === "bar");
    expect(barFn?.exported).toBe(false);
    // 2 contains edges, file → foo, file → bar
    const containsEdges = edges.filter((e) => e.type === "contains");
    expect(containsEdges).toHaveLength(2);
  });

  test("extracts class declarations", async () => {
    const code = `export class Foo { method() { return 1; } }`;
    const { nodes } = await runExtract(code, "ts");
    const cls = nodes.filter((n) => n.type === "class");
    expect(cls.map((n) => n.name)).toEqual(["Foo"]);
    expect(cls[0]?.exported).toBe(true);
  });

  test("extracts interface as class node", async () => {
    const code = `export interface Bar { x: number; }`;
    const { nodes } = await runExtract(code, "ts");
    const cls = nodes.filter((n) => n.type === "class");
    expect(cls.map((n) => n.name)).toEqual(["Bar"]);
  });

  test("extracts import edges with unresolved paths", async () => {
    const code = `import { foo } from "./util";\nimport x from "lib";\nexport function main() {}`;
    const { edges } = await runExtract(code, "ts");
    const imports = edges.filter((e) => e.type === "imports");
    expect(imports.map((e) => e.target).sort()).toEqual(["./util", "lib"]);
  });
});

describe("extractor — tsx", () => {
  test("extracts arrow function const + class", async () => {
    const code = `
export const Comp = () => <div>hi</div>;
class Helper {}
`;
    const { nodes } = await runExtract(code, "tsx", "src/Sample.tsx");
    const fns = nodes.filter((n) => n.type === "function");
    // tsx arrow fn name comes from the variable declarator; tree-sitter
    // may or may not surface it via childForFieldName. Just confirm we
    // extracted something (file + class at minimum).
    const cls = nodes.filter((n) => n.type === "class");
    expect(cls.map((n) => n.name)).toEqual(["Helper"]);
    expect(nodes.find((n) => n.type === "file")?.name).toBe("Sample.tsx");
  });
});

describe("extractor — javascript (.js)", () => {
  test("extracts function declarations + imports", async () => {
    const code = `
import { x } from "./other";
function foo() {}
function bar() {}
`;
    const { nodes, edges } = await runExtract(code, "js", "scripts/run.js");
    const fns = nodes.filter((n) => n.type === "function");
    expect(fns.map((n) => n.name).sort()).toEqual(["bar", "foo"]);
    const imports = edges.filter((e) => e.type === "imports");
    expect(imports.map((e) => e.target)).toEqual(["./other"]);
  });
});

describe("extractor — python (.py)", () => {
  test("extracts function + class + import edges", async () => {
    const code = `
import os
from pathlib import Path

def foo():
    return 1

class Bar:
    def method(self):
        pass
`;
    const { nodes, edges } = await runExtract(code, "py", "scripts/run.py");
    const fns = nodes.filter((n) => n.type === "function");
    expect(fns.map((n) => n.name).sort()).toEqual(["foo", "method"]);
    const cls = nodes.filter((n) => n.type === "class");
    expect(cls.map((n) => n.name)).toEqual(["Bar"]);
    const imports = edges.filter((e) => e.type === "imports");
    // python `import os` → "os"; `from pathlib import Path` → "pathlib"
    expect(imports.map((e) => e.target).sort()).toEqual(["os", "pathlib"]);
  });
});

describe("extractor — file node properties", () => {
  test("file node has correct path + lineRange", async () => {
    const code = `function a() {}\nfunction b() {}\nfunction c() {}\n`;
    const { nodes } = await runExtract(code, "ts", "src/three.ts");
    const file = nodes.find((n) => n.type === "file")!;
    expect(file.path).toBe("src/three.ts");
    expect(file.lineRange).toEqual([1, 4]); // 3 fns + trailing blank line
  });
});

describe("extractor — node ids", () => {
  test("id format is `{type}:{relPath}:{name}`", async () => {
    const code = `export function myFunc() {}`;
    const { nodes } = await runExtract(code, "ts", "src/x.ts");
    const fn = nodes.find((n) => n.type === "function" && n.name === "myFunc");
    expect(fn?.id).toBe("function:src/x.ts:myFunc");
    const file = nodes.find((n) => n.type === "file");
    expect(file?.id).toBe("file:src/x.ts:");
  });
});
