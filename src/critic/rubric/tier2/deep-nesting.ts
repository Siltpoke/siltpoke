// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricRule, RubricTrigger } from "../types";
import { parseSource, type SupportedLang } from "./ast-loader";

const DEPTH_THRESHOLD = 3; // trigger at depth > 3 (i.e., 4+)

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

/** TS/JS node types that contribute to nesting depth */
const TS_NESTING_NODES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "try_statement",
  "switch_statement",
]);

/** Python node types that contribute to nesting depth */
const PY_NESTING_NODES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
  "switch_statement",
  "with_statement",
]);

interface NestingViolation {
  line: number; // 1-based
  depth: number;
  nodeType: string;
  snippet: string;
}

function findNestingViolations(
  root: SyntaxNode,
  lang: SupportedLang,
  sourceLines: string[],
): NestingViolation[] {
  const nestingNodes = lang === "py" ? PY_NESTING_NODES : TS_NESTING_NODES;
  const violations: NestingViolation[] = [];
  const reported = new Set<number>(); // avoid duplicate line reports

  function walk(node: SyntaxNode, depth: number): void {
    const isNester = nestingNodes.has(node.type);
    const currentDepth = isNester ? depth + 1 : depth;

    if (isNester && currentDepth > DEPTH_THRESHOLD) {
      const line = node.startPosition.row; // 0-based
      if (!reported.has(line)) {
        reported.add(line);
        violations.push({
          line: line + 1,
          depth: currentDepth,
          nodeType: node.type,
          snippet: sourceLines[line] ?? "",
        });
      }
    }

    for (const child of node.namedChildren) {
      walk(child, currentDepth);
    }
  }

  walk(root, 0);
  return violations;
}

export const deepNestingRule: RubricRule = {
  id: "deep-nesting",
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
      const violations = findNestingViolations(tree.rootNode, lang, lines);

      for (const v of violations) {
        triggers.push({
          rule_id: "deep-nesting",
          tier: 2 as const,
          severity: "high",
          file,
          line: v.line,
          snippet: v.snippet,
          message: `Nesting depth ${v.depth} exceeds threshold (${DEPTH_THRESHOLD}) at '${v.nodeType}'. Deep nesting harms readability and testability.`,
          suggested_fix:
            "Extract deeply-nested logic into well-named functions. Use early returns / guard clauses to reduce nesting.",
        });
      }
    }

    return {
      rule_id: "deep-nesting",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
