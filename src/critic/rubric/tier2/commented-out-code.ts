// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode, } from "web-tree-sitter";
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

/** Strip comment markers to get raw body text */
function stripCommentMarker(commentText: string, lang: SupportedLang): string {
  if (lang === "py") {
    return commentText.replace(/^#+\s?/, "");
  }
  // TS/JS: strip // prefix
  return commentText.replace(/^\/\/\s?/, "");
}

/** Return true if this comment is a block/JSDoc comment (not a line comment) */
function isBlockComment(commentText: string): boolean {
  const trimmed = commentText.trim();
  return trimmed.startsWith("/*");
}

/** Return true if the comment body is a visual section divider (e.g. // ------, // ======) */
function isSectionDivider(commentText: string, lang: SupportedLang): boolean {
  const body = stripCommentMarker(commentText, lang);
  // Match bodies consisting entirely of repeated separator characters (with optional surrounding whitespace)
  return /^\s*[-=*#_─-╿]{3,}\s*$/.test(body);
}

/** Count ERROR nodes recursively in a tree */
function countErrors(node: SyntaxNode): number {
  let count = node.type === "ERROR" ? 1 : 0;
  for (const child of node.namedChildren) {
    count += countErrors(child);
  }
  return count;
}

/**
 * Collect consecutive line-comment blocks (≥2) from the AST.
 * Divider-only comments are excluded from each block; if the remaining
 * block has fewer than 2 comments it is dropped entirely.
 * Returns arrays of comment node groups.
 */
function collectConsecutiveCommentBlocks(
  root: SyntaxNode,
  lang: SupportedLang,
): SyntaxNode[][] {
  const blocks: SyntaxNode[][] = [];

  function flush(current: SyntaxNode[]): void {
    // Remove visual section dividers before deciding whether to keep the block
    const filtered = current.filter((c) => !isSectionDivider(c.text, lang));
    if (filtered.length >= 2) {
      blocks.push(filtered);
    }
  }

  function walk(node: SyntaxNode): void {
    // Only look at direct children — top-level walk
    const children = node.children; // includes non-named nodes for complete traversal
    let current: SyntaxNode[] = [];

    for (const child of children) {
      if (child.type === "comment" && !isBlockComment(child.text)) {
        current.push(child);
      } else if (child.type !== "comment") {
        flush(current);
        current = [];
        // Recurse into non-comment nodes to find nested consecutive comments
        walk(child);
      }
    }
    flush(current);
  }

  walk(root);
  return blocks;
}

/**
 * Check if a block of consecutive comments looks like commented-out code.
 * Strips comment markers, joins lines, and tries to parse as code.
 * Returns true if the parse tree has at most 1 ERROR node (tolerant).
 */
async function looksLikeCode(
  comments: SyntaxNode[],
  lang: SupportedLang,
): Promise<boolean> {
  const stripped = comments
    .map((c) => stripCommentMarker(c.text, lang))
    .join("\n");

  // Skip if stripped content is very short (< 5 chars total)
  if (stripped.trim().length < 5) return false;

  const tree = await parseSource(stripped, lang);
  if (!tree) return false;

  const errors = countErrors(tree.rootNode);
  // Tolerant: at most 1 ERROR node in the whole subtree
  return errors <= 1;
}

export const commentedOutCodeRule: RubricRule = {
  id: "commented-out-code",
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
      const blocks = collectConsecutiveCommentBlocks(tree.rootNode, lang);

      for (const block of blocks) {
        const isCode = await looksLikeCode(block, lang);
        if (!isCode) continue;

        const startLine = block[0].startPosition.row;
        const endLine = block[block.length - 1].startPosition.row;

        triggers.push({
          rule_id: "commented-out-code",
          tier: 2 as const,
          severity: "low",
          file,
          line: startLine + 1,
          end_line: endLine + 1,
          snippet: lines[startLine] ?? block[0].text,
          message: `${block.length} consecutive comments appear to contain commented-out code. Dead code in comments creates noise and confusion.`,
          suggested_fix:
            "Remove commented-out code. If you need it later, retrieve it from version control history.",
        });
      }
    }

    return {
      rule_id: "commented-out-code",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
