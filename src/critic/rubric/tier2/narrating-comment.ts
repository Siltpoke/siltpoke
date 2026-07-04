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

function detectLang(filePath: string): SupportedLang | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_FROM_EXT[ext] ?? null;
}

/**
 * Stop words excluded from both comment and code token sets.
 * These are too common to be meaningful in the narration heuristic.
 */
const STOP_WORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "import", "export", "default", "new", "this", "true", "false",
  "null", "type", "async", "await", "from", "the", "and", "are", "not",
  "get", "set", "has", "can", "its", "def", "self", "that", "with", "you",
  "void", "bool", "int", "str", "any",
]);

/**
 * Tokenize text: split camelCase/PascalCase, lowercase, drop short tokens
 * (< 3 chars), remove stop words.
 */
function tokenize(text: string, excludeStopWords = false): string[] {
  const expanded = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  const tokens = expanded
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2); // 3+ chars only

  if (excludeStopWords) {
    return [...new Set(tokens.filter((t) => !STOP_WORDS.has(t)))];
  }
  return [...new Set(tokens)];
}

/**
 * Return true if this comment node should be skipped:
 * - JSDoc / block comments (leading `/**` or `/*`)
 * - License headers (contain "license", "copyright", "spdx")
 */
function shouldSkipComment(commentText: string): boolean {
  const trimmed = commentText.trim();
  if (trimmed.startsWith("/**") || trimmed.startsWith("/*")) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.includes("license") ||
    lower.includes("copyright") ||
    lower.includes("spdx")
  );
}

/** Strip leading comment markers and return the body text */
function extractCommentBody(commentText: string): string {
  return commentText
    .replace(/^\/\/+\s*/, "")
    .replace(/^#+\s*/, "")
    .replace(/^\/\*+\s*/, "")
    .replace(/\s*\*+\/\s*$/, "")
    .replace(/^\*\s?/, "")
    .trim();
}

/** Advance past consecutive comment siblings to find the next non-comment sibling */
function nextNonCommentSibling(node: SyntaxNode): SyntaxNode | null {
  let n: SyntaxNode | null = node.nextSibling;
  while (n && n.type === "comment") n = n.nextSibling;
  return n;
}

/**
 * A comment narrates the next line when:
 * 1. The comment has ≥ 2 meaningful tokens (after stop-word removal)
 * 2. All meaningful code tokens from the next sibling are present in the comment tokens
 *    (i.e., the comment names exactly what the code does)
 */
function findNarratingComments(
  root: SyntaxNode,
  sourceLines: string[],
): Array<{ line: number; snippet: string }> {
  const results: Array<{ line: number; snippet: string }> = [];

  function walk(node: SyntaxNode): void {
    if (node.type === "comment") {
      const commentText = node.text;

      if (!shouldSkipComment(commentText)) {
        const body = extractCommentBody(commentText);
        const commentTokenSet = new Set(tokenize(body, true));

        if (commentTokenSet.size >= 2) {
          const nextSibling = nextNonCommentSibling(node);
          if (nextSibling) {
            const codeTokens = tokenize(nextSibling.text, true);

            if (
              codeTokens.length >= 1 &&
              codeTokens.every((t) => commentTokenSet.has(t))
            ) {
              const line = node.startPosition.row;
              results.push({
                line: line + 1,
                snippet: sourceLines[line] ?? commentText,
              });
            }
          }
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

export const narratingCommentRule: RubricRule = {
  id: "narrating-comment",
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
      const violations = findNarratingComments(tree.rootNode, lines);

      for (const v of violations) {
        triggers.push({
          rule_id: "narrating-comment",
          tier: 2 as const,
          severity: "med",
          file,
          line: v.line,
          snippet: v.snippet,
          message: `Narrating comment repeats what the next line already says. Comments should explain "why", not "what".`,
          suggested_fix:
            "Remove the comment and rename the variable/function to be self-explanatory, or rewrite the comment to explain intent rather than action.",
        });
      }
    }

    return {
      rule_id: "narrating-comment",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
