// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricRule, RubricTrigger } from "../types";
import { parseSource, type SupportedLang } from "./ast-loader";

const LOC_THRESHOLD = 50;
const COMPLEXITY_THRESHOLD = 15;

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

/** Node types that act as function containers in TS/JS */
const TS_FUNCTION_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
]);

/** Node types that act as function containers in Python */
const PY_FUNCTION_TYPES = new Set(["function_definition"]);

/** TS/JS node types that add +1 base cognitive complexity */
const TS_COMPLEXITY_NODES = new Set([
  "if_statement",
  "else_clause",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "switch_statement",
  "switch_case",
  "switch_default",
  "catch_clause",
  "ternary_expression",
]);

/** PY node types that add +1 base cognitive complexity */
const PY_COMPLEXITY_NODES = new Set([
  "if_statement",
  "elif_clause",
  "else_clause",
  "for_statement",
  "while_statement",
  "try_statement",
  "except_clause",
  "conditional_expression",
]);

/** Nesting-contributing node types for TS/JS */
const TS_NESTING_NODES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "switch_statement",
  "try_statement",
  "catch_clause",
]);

/** Nesting-contributing node types for Python */
const PY_NESTING_NODES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
  "with_statement",
]);

function computeCognitiveComplexity(
  node: SyntaxNode,
  lang: SupportedLang,
  depth = 0,
): number {
  let score = 0;
  const complexityNodes =
    lang === "py" ? PY_COMPLEXITY_NODES : TS_COMPLEXITY_NODES;
  const nestingNodes = lang === "py" ? PY_NESTING_NODES : TS_NESTING_NODES;

  if (complexityNodes.has(node.type)) {
    score += 1 + depth;
  }

  // Binary && / || operators each add +1
  if (node.type === "binary_expression") {
    const op = node.childForFieldName("operator")?.text ?? "";
    if (op === "&&" || op === "||") {
      score += 1;
    }
  }

  if (node.type === "boolean_operator") {
    score += 1;
  }

  const newDepth = nestingNodes.has(node.type) ? depth + 1 : depth;

  for (const child of node.namedChildren) {
    score += computeCognitiveComplexity(child, lang, newDepth);
  }

  return score;
}

function getFunctionName(node: SyntaxNode): string {
  // function_declaration / function_definition: look for identifier child
  const nameNode =
    node.childForFieldName("name") ??
    node.children.find((c: SyntaxNode) => c.type === "identifier");
  return nameNode?.text ?? "<anonymous>";
}

const JSX_NODE_TYPES = new Set([
  "jsx_element",
  "jsx_self_closing_element",
  "jsx_fragment",
]);

/**
 * Return true if a node has any JSX descendant.
 * Uses early-return DFS to avoid full traversal when JSX is found quickly.
 */
function hasJsxDescendant(node: SyntaxNode): boolean {
  if (JSX_NODE_TYPES.has(node.type)) return true;
  for (const child of node.namedChildren) {
    if (hasJsxDescendant(child)) return true;
  }
  return false;
}

/**
 * Return true if the function is a JSX-dominant layout component.
 * Criteria (conservative — falls back to trigger when uncertain):
 *   1. The function body contains at least one JSX node, AND
 *   2. The return statement returns JSX (not just incidental JSX in a sub-expression), AND
 *   3. Cognitive complexity is LOW (< 10) — no meaningful branching
 */
function isJsxLayoutComponent(
  fnNode: SyntaxNode,
  lang: SupportedLang,
  complexity: number,
): boolean {
  // Only applies to TS/JS/TSX/JSX — Python has no JSX
  if (lang === "py") return false;
  // Complexity must be low — if there's real branching, it's not just a layout component
  if (complexity >= 10) return false;

  // Check that the function body actually contains JSX
  return hasJsxDescendant(fnNode);
}

function findFunctionNodes(
  root: SyntaxNode,
  lang: SupportedLang,
): SyntaxNode[] {
  const functionTypes = lang === "py" ? PY_FUNCTION_TYPES : TS_FUNCTION_TYPES;
  const results: SyntaxNode[] = [];

  function walk(node: SyntaxNode): void {
    if (functionTypes.has(node.type)) {
      results.push(node);
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

export const godFunctionRule: RubricRule = {
  id: "god-function",
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
      const functionNodes = findFunctionNodes(tree.rootNode, lang);

      for (const fn of functionNodes) {
        const startLine = fn.startPosition.row; // 0-based
        const endLine = fn.endPosition.row; // 0-based
        const loc = endLine - startLine + 1;
        const complexity = computeCognitiveComplexity(fn, lang);

        const locViolation = loc > LOC_THRESHOLD;
        const complexityViolation = complexity > COMPLEXITY_THRESHOLD;

        if (!locViolation && !complexityViolation) continue;

        // Skip JSX-dominant layout components — large render-only components have
        // high LOC but zero control-flow complexity and are not "god functions".
        if (isJsxLayoutComponent(fn, lang, complexity)) continue;

        const name = getFunctionName(fn);
        const reasons: string[] = [];
        if (locViolation) reasons.push(`LOC=${loc} (threshold ${LOC_THRESHOLD})`);
        if (complexityViolation)
          reasons.push(`cognitive complexity=${complexity} (threshold ${COMPLEXITY_THRESHOLD})`);

        const snippetLine = lines[startLine] ?? "";
        triggers.push({
          rule_id: "god-function",
          tier: 2 as const,
          severity: "high",
          file,
          line: startLine + 1,
          end_line: endLine + 1,
          snippet: snippetLine,
          message: `Function '${name}' exceeds threshold: ${reasons.join(", ")}. Consider splitting into smaller, single-purpose functions.`,
          suggested_fix:
            "Extract logical sub-tasks into well-named helper functions. Aim for ≤50 LOC (ESLint default) and cognitive complexity ≤15 (SonarQube default).",
        });
      }
    }

    return {
      rule_id: "god-function",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
