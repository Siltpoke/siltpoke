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

/** Maximum triggers reported per file to prevent spam */
const MAX_TRIGGERS_PER_FILE = 3;

function detectLang(filePath: string): SupportedLang | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_FROM_EXT[ext] ?? null;
}

/** TS/JS boolean literal node types */
const TS_BOOL_TYPES = new Set(["true", "false"]);

/** Python boolean literal node types */
const _PY_BOOL_TYPES = new Set(["true", "false"]);

function isBooleanLiteral(node: SyntaxNode, lang: SupportedLang): boolean {
  if (lang === "py") {
    // Python uses identifier nodes for True/False
    return node.type === "true" || node.type === "false";
  }
  return TS_BOOL_TYPES.has(node.type);
}

interface BoolParamViolation {
  line: number;
  snippet: string;
  funcName: string;
}

function findBooleanParamCalls(
  root: SyntaxNode,
  lang: SupportedLang,
  sourceLines: string[],
): BoolParamViolation[] {
  const results: BoolParamViolation[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === "call_expression") {
      const argsNode = node.childForFieldName("arguments");
      if (argsNode) {
        const args = argsNode.namedChildren;

        // Must have 2+ positional arguments AND at least one must be a boolean literal
        if (
          args.length >= 2 &&
          args.some((arg) => isBooleanLiteral(arg, lang))
        ) {
          const line = node.startPosition.row;
          // Derive function name from the function part of the call
          const funcNode =
            node.childForFieldName("function") ?? node.namedChildren[0];
          const funcName = funcNode?.text ?? "<unknown>";
          results.push({
            line: line + 1,
            snippet: sourceLines[line] ?? node.text,
            funcName,
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

export const booleanParamRule: RubricRule = {
  id: "boolean-param",
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
      const violations = findBooleanParamCalls(tree.rootNode, lang, lines);

      // Cap at MAX_TRIGGERS_PER_FILE per file
      const capped = violations.slice(0, MAX_TRIGGERS_PER_FILE);

      for (const v of capped) {
        triggers.push({
          rule_id: "boolean-param",
          tier: 2 as const,
          severity: "med",
          file,
          line: v.line,
          snippet: v.snippet,
          message: `Boolean literal passed as positional argument to '${v.funcName}'. Boolean flags obscure call-site intent.`,
          suggested_fix:
            "Replace the boolean flag with an options object: `{ visible: true }` instead of `true`. Or split into two separate functions.",
        });
      }
    }

    return {
      rule_id: "boolean-param",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
