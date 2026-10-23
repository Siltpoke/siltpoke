import { describe, expect, it } from "bun:test";
import { resolvedImportPairs } from "../../src/repo-graph/trust-imports";
import type { RepoGraph } from "../../src/repo-graph/types";

// File nodes + import edges shaped exactly as the extractor writes them
// (`file:{relPath}:` id, `imports` edge with a raw unresolved `target` —
// copied shape from tests/e2e/_setup/seed-repo-graph.ts:58-60). Includes a
// colon/space path (`src/a b/z:1.ts`) — Review Focus 1: the aggregator's own
// `/^file:([^:]+):$/` regex drops any source id containing a colon in the
// path, so `resolvedImportPairs` must use a greedy regex instead or this
// file's import edge silently vanishes.
const graph: RepoGraph = {
  schemaVersion: 1,
  nodes: [
    { id: "file:src/a/x.ts:", type: "file", name: "x.ts", path: "src/a/x.ts", lineRange: [1, 1] },
    { id: "file:src/b/y.ts:", type: "file", name: "y.ts", path: "src/b/y.ts", lineRange: [1, 1] },
    { id: "file:src/a b/z:1.ts:", type: "file", name: "z:1.ts", path: "src/a b/z:1.ts", lineRange: [1, 1] },
  ],
  edges: [
    { id: "e1", source: "file:src/a/x.ts:", target: "../b/y", type: "imports", weight: 1 },
    { id: "e2", source: "file:src/a b/z:1.ts:", target: "../a/x", type: "imports", weight: 1 },
  ],
};

describe("resolvedImportPairs (Review Focus 1 — colon/space paths must not drop out)", () => {
  it("resolves a plain relative import to its concrete file pair", () => {
    const pairs = resolvedImportPairs(graph);
    expect(pairs).toContainEqual(["src/a/x.ts", "src/b/y.ts"]);
  });

  it("resolves the pair whose source path contains a colon and a space", () => {
    const pairs = resolvedImportPairs(graph);
    expect(pairs).toContainEqual(["src/a b/z:1.ts", "src/a/x.ts"]);
  });
});
