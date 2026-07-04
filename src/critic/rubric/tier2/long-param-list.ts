// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricRule, RubricTrigger } from "../types";
import { parseSource, type SupportedLang } from "./ast-loader";

const PARAM_THRESHOLD = 4; // trigger at 5+

/** Parameter names excluded from the count */
const EXCLUDED_PARAMS = new Set(["this", "self", "cls", "ctx"]);

const LANG_FROM_EXT: Record<string, SupportedLang> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "py",
};

function detectLang(filePath: string): SupportedLang | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_FROM_EXT[ext] ?? null;
}

/** Node types that represent function containers in TS/JS */
const TS_FUNCTION_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
]);

/** Node types that represent function containers in Python */
const PY_FUNCTION_TYPES = new Set(["function_definition"]);

/**
 * Extract the effective parameter name from a TS/JS parameter node.
 * The first identifier child is the name (covers required_parameter,
 * optional_parameter, rest_parameter, assignment_pattern, etc.)
 */
function getTsParamName(paramNode: SyntaxNode): string | null {
  // For simple identifiers used directly (non-typed params)
  if (paramNode.type === "identifier") return paramNode.text;
  // For typed / optional / rest params the first named child is the identifier
  // or a 'this' keyword node (explicit TS this-parameter)
  const first = paramNode.namedChildren[0];
  if (!first) return null;
  if (first.type === "identifier" || first.type === "this") return first.text;
  // For destructured params we cannot determine a simple name; count them
  return null;
}

/**
 * Count effective parameters for a TS/JS function node.
 * Excludes `this` and `ctx` from the count.
 */
function countTsParams(fnNode: SyntaxNode): number {
  const params = fnNode.childForFieldName("parameters");
  if (!params) return 0;

  let count = 0;
  for (const child of params.namedChildren) {
    const name = getTsParamName(child);
    if (name !== null && EXCLUDED_PARAMS.has(name)) continue;
    count++;
  }
  return count;
}

/**
 * Count effective parameters for a Python function node.
 * Excludes `self`, `cls`, `ctx`.
 */
function countPyParams(fnNode: SyntaxNode): number {
  const params = fnNode.childForFieldName("parameters");
  if (!params) return 0;

  let count = 0;
  for (const child of params.namedChildren) {
    let name: string | null = null;

    if (child.type === "identifier") {
      name = child.text;
    } else if (
      child.type === "typed_parameter" ||
      child.type === "default_parameter" ||
      child.type === "typed_default_parameter"
    ) {
      const first = child.namedChildren[0];
      if (first?.type === "identifier") name = first.text;
    }

    if (name !== null && EXCLUDED_PARAMS.has(name)) continue;
    count++;
  }
  return count;
}

function getFunctionName(node: SyntaxNode): string {
  const nameNode =
    node.childForFieldName("name") ??
    node.namedChildren.find((c: SyntaxNode) => c.type === "identifier");
  return nameNode?.text ?? "<anonymous>";
}

function collectFunctions(root: SyntaxNode, lang: SupportedLang): SyntaxNode[] {
  const fnTypes = lang === "py" ? PY_FUNCTION_TYPES : TS_FUNCTION_TYPES;
  const results: SyntaxNode[] = [];

  function walk(node: SyntaxNode): void {
    if (fnTypes.has(node.type)) results.push(node);
    for (const child of node.namedChildren) walk(child);
  }

  walk(root);
  return results;
}

export const longParamListRule: RubricRule = {
  id: "long-param-list",
  tier: 2,
  languages: ["ts", "tsx", "js", "jsx", "py"],

  async run(input) {
    const t0 = performance.now();
    const triggers: RubricTrigger[] = [];

    for (const file of input.changedFiles) {
      const lang = detectLang(file);
      if (!lang) continue;

      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }

      const tree = await parseSource(source, lang);
      if (!tree) continue;

      const lines = source.split("\n");
      const functions = collectFunctions(tree.rootNode, lang);

      for (const fn of functions) {
        const effectiveCount =
          lang === "py" ? countPyParams(fn) : countTsParams(fn);

        if (effectiveCount <= PARAM_THRESHOLD) continue;

        const name = getFunctionName(fn);
        const startLine = fn.startPosition.row; // 0-based
        const snippet = lines[startLine] ?? "";

        triggers.push({
          rule_id: "long-param-list",
          tier: 2 as const,
          severity: "med",
          file,
          line: startLine + 1,
          snippet,
          message: `Function '${name}' has ${effectiveCount} params (threshold ${PARAM_THRESHOLD}). Too many params increase call-site complexity and reduce testability.`,
          suggested_fix:
            "Group related params into a config/options object. Consider the parameter object refactoring pattern.",
        });
      }
    }

    return {
      rule_id: "long-param-list",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
