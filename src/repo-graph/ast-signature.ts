// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * AST signature for incremental rebuild detection.
 *
 * Signature = `sha256( JSON.stringify({ maxDepth, histogram }) )[:8]`
 *
 * - `maxDepth` — max depth of the tree-sitter parse tree
 * - `histogram` — count of each node type in the tree (sorted by type)
 *
 * Whitespace + comment changes don't affect structure → same sig → file
 * cached. Real structural edits (new function, class rename) shift the
 * histogram → different sig → file re-walked.
 */
import { createHash } from "node:crypto";
import type { Tree, Node } from "web-tree-sitter";

interface AstStats {
  maxDepth: number;
  histogram: Record<string, number>;
}

function walkStats(root: Node): AstStats {
  let maxDepth = 0;
  const histogram: Record<string, number> = {};

  // Iterative DFS with explicit depth tracking to avoid stack blow-up
  // on deeply-nested trees (e.g., long ternary chains).
  const stack: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > maxDepth) maxDepth = depth;
    const type = node.type;
    histogram[type] = (histogram[type] ?? 0) + 1;
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, depth: depth + 1 });
    }
  }

  return { maxDepth, histogram };
}

/**
 * Compute an 8-hex-char AST signature for a parsed tree-sitter tree.
 * Two trees with the same depth + same node-type distribution share a
 * signature even if their leaf text differs (e.g., variable rename).
 *
 * This is intentional: identifier renames don't structurally change
 * the code shape for graph-extraction purposes. Real structural edits
 * (adding a function, changing a class hierarchy) shift the histogram.
 */
export function computeAstSignature(tree: Tree): string {
  const stats = walkStats(tree.rootNode);
  // Sort histogram keys for stable JSON output.
  const sortedHistogram: Record<string, number> = {};
  for (const key of Object.keys(stats.histogram).sort()) {
    sortedHistogram[key] = stats.histogram[key]!;
  }
  const json = JSON.stringify({ maxDepth: stats.maxDepth, histogram: sortedHistogram });
  return createHash("sha256").update(json).digest("hex").slice(0, 8);
}
