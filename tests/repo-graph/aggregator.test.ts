/**
 * aggregator tests (rich/degraded modes +
 * import-count aggregation).
 */
import { test, expect, describe } from "bun:test";
import {
  aggregateBySuperGroup,
  type AggregatedGraph,
} from "../../src/repo-graph/aggregator";
import type {
  AnchorMap,
  RepoGraph,
  SiltpokeGraphEdge,
  SiltpokeGraphNode,
} from "../../src/repo-graph/types";
import { emptyGraph } from "../../src/repo-graph/types";
import type { ArchitectureOverlay } from "../../src/repo-graph/architecture-parser";

function fileNode(path: string): SiltpokeGraphNode {
  return {
    id: `file:${path}:`,
    type: "file",
    name: path,
    path,
    lineRange: [1, 100],
  };
}

function importsEdge(sourcePath: string, importStr: string): SiltpokeGraphEdge {
  return {
    id: `file:${sourcePath}:::imports::${importStr}`,
    source: `file:${sourcePath}:`,
    target: importStr,
    type: "imports",
    weight: 1,
  };
}

function makeGraph(filePaths: string[], imports: Array<[string, string]> = []): RepoGraph {
  const g = emptyGraph();
  g.nodes = filePaths.map(fileNode);
  g.edges = imports.map(([src, imp]) => importsEdge(src, imp));
  return g;
}

describe("aggregateBySuperGroup — rich mode (overlay non-null)", () => {
  test("panels match overlay's super-group names, in overlay order", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        { name: "Core", subdirs: [{ path: "src/brain/", purpose: "p1" }] },
        { name: "State", subdirs: [{ path: "src/memory/", purpose: "p2" }] },
      ],
    };
    const graph = makeGraph(["src/brain/a.ts", "src/memory/b.ts"]);
    const result = aggregateBySuperGroup(graph, overlay);
    expect(result.mode).toBe("rich");
    expect(result.panels.map((p) => p.name)).toEqual(["Core", "State"]);
  });

  test("subdir nodes carry purpose strings from the overlay", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        { name: "Core", subdirs: [{ path: "src/brain/", purpose: "claude subprocess" }] },
      ],
    };
    const graph = makeGraph(["src/brain/a.ts"]);
    const result = aggregateBySuperGroup(graph, overlay);
    const brain = result.subdirNodes.find((s) => s.path === "src/brain/");
    expect(brain?.purpose).toBe("claude subprocess");
  });

  test("subdir declared in overlay but with no files in graph → fileCount 0 (still rendered)", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        {
          name: "Core",
          subdirs: [
            { path: "src/brain/", purpose: "p1" },
            { path: "src/ghost/", purpose: "p2 — declared but absent" },
          ],
        },
      ],
    };
    const graph = makeGraph(["src/brain/a.ts"]);
    const result = aggregateBySuperGroup(graph, overlay);
    const ghost = result.subdirNodes.find((s) => s.path === "src/ghost/");
    expect(ghost).toBeDefined();
    expect(ghost?.fileCount).toBe(0);
  });

  test("subdir present in graph but NOT in overlay → assigned to synthetic 'Other' panel", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        { name: "Core", subdirs: [{ path: "src/brain/", purpose: "p1" }] },
      ],
    };
    const graph = makeGraph(["src/brain/a.ts", "src/orphan/b.ts"]);
    const result = aggregateBySuperGroup(graph, overlay);
    const orphan = result.subdirNodes.find((s) => s.path === "src/orphan/");
    expect(orphan).toBeDefined();
    expect(orphan?.superGroup).toBe("Other");
    expect(result.panels.map((p) => p.name)).toContain("Other");
  });
});

describe("aggregateBySuperGroup — degraded mode (overlay null, structural deriveContainers)", () => {
  // NOTE: degraded containers are now derived purely structurally
  // (branch-point + gap-descend), NOT from a hardcoded WELL_KNOWN_ROOTS list.
  // On these single-root fixtures the structural result coincides with the old
  // depth-2 output (`src/foo/` etc.); the divergence shows only on real
  // multi-root monorepos (1→19 containers), locked by the bucketing snapshot test.
  test("groups by `src/<subdir>/*` when src is the only top namespace", () => {
    const graph = makeGraph(["src/foo/a.ts", "src/bar/b.ts", "src/foo/c.ts"]);
    const result = aggregateBySuperGroup(graph, null);
    expect(result.mode).toBe("degraded");
    const paths = result.subdirNodes.map((s) => s.path).sort();
    expect(paths).toEqual(["src/bar/", "src/foo/"]);
    expect(result.subdirNodes.find((s) => s.path === "src/foo/")?.fileCount).toBe(2);
  });

  test("a `lib/`-rooted repo derives its children (no name privilege)", () => {
    const graph = makeGraph(["lib/foo/a.ts", "lib/bar/b.ts"]);
    const result = aggregateBySuperGroup(graph, null);
    expect(result.mode).toBe("degraded");
    expect(result.subdirNodes.map((s) => s.path).sort()).toEqual(["lib/bar/", "lib/foo/"]);
  });

  test("a `packages/`-rooted repo derives its children", () => {
    const graph = makeGraph(["packages/foo/a.ts", "packages/bar/b.ts"]);
    const result = aggregateBySuperGroup(graph, null);
    expect(result.subdirNodes.map((s) => s.path).sort()).toEqual([
      "packages/bar/",
      "packages/foo/",
    ]);
  });

  test("a single deep chain compresses to its first branch (`app/foo/`)", () => {
    const graph = makeGraph(["app/foo/a.ts"]);
    const result = aggregateBySuperGroup(graph, null);
    expect(result.subdirNodes[0]?.path).toBe("app/foo/");
  });

  test("MULTI-root repo: ALL top namespaces surface (the monorepo-collapse fix)", () => {
    // Old WELL_KNOWN_ROOTS picked ONE root and dropped the rest → collapse.
    // Structural derivation keeps every top namespace.
    const graph = makeGraph([
      "backend/api/a.ts",
      "backend/db/b.ts",
      "frontend/ui/c.ts",
      "scripts/d.ts",
    ]);
    const result = aggregateBySuperGroup(graph, null);
    expect(result.subdirNodes.map((s) => s.path).sort()).toEqual([
      "backend/api/",
      "backend/db/",
      "frontend/ui/",
      "scripts/",
    ]);
  });

  test("degraded subdirs have empty purpose strings (no overlay = no descriptions)", () => {
    const graph = makeGraph(["src/foo/a.ts"]);
    const result = aggregateBySuperGroup(graph, null);
    expect(result.subdirNodes[0]?.purpose).toBe("");
  });
});

describe("aggregateBySuperGroup — tier-4 anchored edges (anchorMap threading)", () => {
  const graph = makeGraph(
    ["src/a/x.ts", "src/b/y.ts"],
    [["src/a/x.ts", "@/b/y"]], // an aliased cross-container import
  );
  const anchorMap: AnchorMap = {
    tsAliases: [{ scopeDir: "", prefix: "@/", targets: ["src/"] }],
    pythonRoots: [],
  };

  test("with anchorMap → the @/ import becomes a cross-container edge", () => {
    const result = aggregateBySuperGroup(graph, null, anchorMap);
    expect(result.aggregatedEdges).toEqual([
      { source: "src/a/", target: "src/b/", count: 1 },
    ]);
  });

  test("without anchorMap → the @/ import is unresolved → no edge", () => {
    const result = aggregateBySuperGroup(graph, null);
    expect(result.aggregatedEdges).toEqual([]);
  });
});

describe("aggregateBySuperGroup — import-count aggregation", () => {
  test("counts distinct cross-subdir imports + skips same-subdir imports", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        {
          name: "Core",
          subdirs: [
            { path: "src/brain/", purpose: "" },
            { path: "src/critic/", purpose: "" },
          ],
        },
      ],
    };
    const graph = makeGraph(
      ["src/brain/a.ts", "src/brain/b.ts", "src/critic/c.ts"],
      [
        ["src/critic/c.ts", "../brain/a"], // cross-subdir: critic → brain
        ["src/brain/a.ts", "./b"], // same-subdir: skipped
      ],
    );
    const result = aggregateBySuperGroup(graph, overlay);
    expect(result.aggregatedEdges).toEqual([
      { source: "src/critic/", target: "src/brain/", count: 1 },
    ]);
  });

  test("direction-aware: A→B and B→A are separate aggregated edges", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        {
          name: "Core",
          subdirs: [
            { path: "src/brain/", purpose: "" },
            { path: "src/critic/", purpose: "" },
          ],
        },
      ],
    };
    const graph = makeGraph(
      ["src/brain/a.ts", "src/critic/c.ts"],
      [
        ["src/critic/c.ts", "../brain/a"],
        ["src/brain/a.ts", "../critic/c"],
      ],
    );
    const result = aggregateBySuperGroup(graph, overlay);
    expect(result.aggregatedEdges).toHaveLength(2);
    const counts = new Map(
      result.aggregatedEdges.map((e) => [`${e.source}->${e.target}`, e.count]),
    );
    expect(counts.get("src/critic/->src/brain/")).toBe(1);
    expect(counts.get("src/brain/->src/critic/")).toBe(1);
  });

  test("external bare specifiers (`hono`, `node:fs`) are skipped — no relative path", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        { name: "Core", subdirs: [{ path: "src/brain/", purpose: "" }] },
      ],
    };
    const graph = makeGraph(
      ["src/brain/a.ts"],
      [
        ["src/brain/a.ts", "hono"],
        ["src/brain/a.ts", "node:fs"],
      ],
    );
    const result = aggregateBySuperGroup(graph, overlay);
    expect(result.aggregatedEdges).toEqual([]);
  });

  test("multiple imports across same subdir pair → count accumulates", () => {
    const overlay: ArchitectureOverlay = {
      superGroups: [
        {
          name: "Core",
          subdirs: [
            { path: "src/brain/", purpose: "" },
            { path: "src/critic/", purpose: "" },
          ],
        },
      ],
    };
    const graph = makeGraph(
      [
        "src/brain/a.ts",
        "src/brain/b.ts",
        "src/critic/c.ts",
        "src/critic/d.ts",
      ],
      [
        ["src/critic/c.ts", "../brain/a"],
        ["src/critic/c.ts", "../brain/b"],
        ["src/critic/d.ts", "../brain/a"],
      ],
    );
    const result = aggregateBySuperGroup(graph, overlay);
    expect(result.aggregatedEdges).toEqual([
      { source: "src/critic/", target: "src/brain/", count: 3 },
    ]);
  });
});
