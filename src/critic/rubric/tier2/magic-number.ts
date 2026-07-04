// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricRule, RubricTrigger } from "../types";
import { parseSource, type SupportedLang } from "./ast-loader";

const LANG_FROM_EXT: Record<string, SupportedLang> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "py",
};

/** Numeric values that are universally understood and should not trigger */
const WHITELISTED_VALUES = new Set(["0", "1", "-1", "100"]);

/** Path patterns that indicate config / constants / test files */
const SKIP_PATH_PATTERNS = [/config/i, /constants/i, /test/i, /spec/i];

function detectLang(filePath: string): SupportedLang | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_FROM_EXT[ext] ?? null;
}

function shouldSkipFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  return SKIP_PATH_PATTERNS.some((p) => p.test(base));
}

/**
 * Return true if the literal node is on the RHS of a `const NAME = <literal>` declaration.
 * Structure: number → variable_declarator → lexical_declaration (firstChild === "const")
 */
function isConstDecl(literal: SyntaxNode): boolean {
  const declarator = literal.parent;
  if (declarator?.type !== "variable_declarator") return false;
  const decl = declarator.parent;
  return (
    decl?.type === "lexical_declaration" && decl.firstChild?.text === "const"
  );
}

/** TS/JS number literal node types */
const TS_NUMBER_TYPES = new Set(["number"]);

/** Python numeric literal node types */
const PY_NUMBER_TYPES = new Set(["integer", "float"]);

function findMagicNumbers(
  root: SyntaxNode,
  lang: SupportedLang,
  sourceLines: string[],
): Array<{ line: number; value: string; snippet: string }> {
  const numberTypes = lang === "py" ? PY_NUMBER_TYPES : TS_NUMBER_TYPES;
  const results: Array<{ line: number; value: string; snippet: string }> = [];

  function walk(node: SyntaxNode): void {
    if (numberTypes.has(node.type)) {
      const raw = node.text;

      if (!WHITELISTED_VALUES.has(raw) && !isConstDecl(node)) {
        const line = node.startPosition.row;
        results.push({
          line: line + 1,
          value: raw,
          snippet: sourceLines[line] ?? raw,
        });
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

export const magicNumberRule: RubricRule = {
  id: "magic-number",
  tier: 2,
  languages: ["ts", "tsx", "js", "jsx", "py"],

  async run(input) {
    const t0 = performance.now();
    const triggers: RubricTrigger[] = [];

    for (const file of input.changedFiles) {
      const lang = detectLang(file);
      if (!lang) continue;

      if (shouldSkipFile(file)) continue;

      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }

      const tree = await parseSource(source, lang);
      if (!tree) continue;

      const lines = source.split("\n");
      const violations = findMagicNumbers(tree.rootNode, lang, lines);

      for (const v of violations) {
        triggers.push({
          rule_id: "magic-number",
          tier: 2 as const,
          severity: "med",
          file,
          line: v.line,
          snippet: v.snippet,
          message: `Magic number ${v.value} found. Unnamed literals obscure intent and make refactoring brittle.`,
          suggested_fix:
            "Extract the value into a named constant: `const DESCRIPTIVE_NAME = ${v.value}`.",
        });
      }
    }

    return {
      rule_id: "magic-number",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
