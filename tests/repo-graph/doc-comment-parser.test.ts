/**
 * top-of-file doc-comment parser tests (file-level
 * scene descriptions). Extracts the first descriptive line from the
 * file's leading JSDoc block, ignoring tags + bodies of nested doc-blocks.
 */
import { test, expect, describe } from "bun:test";
import { parseFirstDocComment } from "../../src/repo-graph/doc-comment-parser";

describe("parseFirstDocComment", () => {
  test("returns first description line from a multi-line /** */ at top of file", () => {
    const src = [
      "/**",
      " * Repo-graph schema types.",
      " *",
      " * Details: see the schema documentation",
      " */",
      "export type Foo = 1;",
      "",
    ].join("\n");
    expect(parseFirstDocComment(src)).toBe(
      "Repo-graph schema types.",
    );
  });

  test("strips @param/@returns/@throws tag lines — returns the descriptive prefix", () => {
    const src = [
      "/**",
      " * Compute the SHA256 of a string.",
      " *",
      " * @param input UTF-8 string",
      " * @returns 64-char hex digest",
      " */",
      "export function sha(input: string): string { return ''; }",
    ].join("\n");
    expect(parseFirstDocComment(src)).toBe("Compute the SHA256 of a string.");
  });

  test("single-line /** foo */ doc-comment works", () => {
    const src = `/** Quick one-liner. */\nexport const x = 1;\n`;
    expect(parseFirstDocComment(src)).toBe("Quick one-liner.");
  });

  test("returns empty string when file has no leading /** */ doc-comment", () => {
    const src = `// just a line comment\nexport const x = 1;\n`;
    expect(parseFirstDocComment(src)).toBe("");
  });

  test("ignores /** */ blocks that are NOT at the top of the file", () => {
    const src = [
      "import { foo } from './x';",
      "",
      "/**",
      " * Description of foo function.",
      " */",
      "export function foo() {}",
      "",
    ].join("\n");
    // Top-of-file leads with an import, not a doc-comment → returns "".
    expect(parseFirstDocComment(src)).toBe("");
  });

  test("skips leading blank lines + line comments before the doc-comment", () => {
    const src = [
      "",
      "// SPDX-License-Identifier: MIT",
      "",
      "/**",
      " * Real description here.",
      " */",
      "export const x = 1;",
    ].join("\n");
    expect(parseFirstDocComment(src)).toBe("Real description here.");
  });
});
