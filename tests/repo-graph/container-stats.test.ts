/**
 * M1 unit — computeContainerStats (literal per-container counts).
 */
import { describe, expect, test } from "bun:test";
import {
  computeContainerStats,
  sumContainerStats,
} from "../../src/repo-graph/container-stats";
import type { RepoGraph } from "../../src/repo-graph/types";

const f = (path: string): RepoGraph["nodes"][number] => ({
  id: `file:${path}:`,
  type: "file",
  name: path.split("/").pop()!,
  path,
  lineRange: [1, 1],
});
const fn = (path: string, name: string): RepoGraph["nodes"][number] => ({
  id: `function:${path}:${name}`,
  type: "function",
  name,
  path,
  lineRange: [1, 1],
});

describe("computeContainerStats", () => {
  test("recurring basename (>=2) counted + sorted desc; singletons dropped", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        f("app/a/page.tsx"),
        f("app/b/page.tsx"),
        f("app/c/page.tsx"),
        f("app/a/layout.tsx"),
        f("app/b/layout.tsx"),
        f("app/a/uniq.ts"),
      ],
      edges: [],
    };
    const stats = computeContainerStats(graph, ["app/"]);
    expect(stats.get("app/")?.fileCount).toBe(6);
    expect(stats.get("app/")?.recurringBasenames).toEqual([
      { name: "page.tsx", count: 3 },
      { name: "layout.tsx", count: 2 },
    ]); // uniq.ts (count 1) dropped
  });

  test("no recurring basename → empty list (degrades to counts only)", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        f("apps/x/models.py"),
        f("apps/x/views.py"),
        f("apps/x/serializers.py"),
        fn("apps/x/views.py", "list_view"),
      ],
      edges: [],
    };
    const stats = computeContainerStats(graph, ["apps/x/"]);
    expect(stats.get("apps/x/")?.recurringBasenames).toEqual([]);
    expect(stats.get("apps/x/")?.fileCount).toBe(3);
    expect(stats.get("apps/x/")?.funcCount).toBe(1);
  });

  test("deepest-prefix scoping — a file is counted in exactly one container", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [f("backend/apps/x.py"), f("backend/config.py")],
      edges: [],
    };
    const stats = computeContainerStats(graph, ["backend/apps/", "backend/config/"]);
    // backend/config.py is NOT under backend/config/ (it's a file, not a dir) → unassigned
    expect(stats.get("backend/apps/")?.fileCount).toBe(1);
    expect(stats.get("backend/config/")?.fileCount).toBe(0);
  });

  test("top-N cap on recurring basenames", () => {
    const nodes: RepoGraph["nodes"] = [];
    for (const base of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      nodes.push(f(`m/1/${base}`), f(`m/2/${base}`)); // each recurs 2×
    }
    const stats = computeContainerStats({ schemaVersion: 1, nodes, edges: [] }, ["m/"], {
      topN: 3,
    });
    expect(stats.get("m/")?.recurringBasenames.length).toBe(3);
  });
});

describe("sumContainerStats (aggregate container — sum, never undercount)", () => {
  test("adds counts + merges recurring basenames by name (count desc)", () => {
    const a = {
      fileCount: 30,
      funcCount: 100,
      recurringBasenames: [
        { name: "page.tsx", count: 3 },
        { name: "x.ts", count: 2 },
      ],
    };
    const b = {
      fileCount: 12,
      funcCount: 40,
      recurringBasenames: [
        { name: "page.tsx", count: 2 }, // same name → merged
        { name: "y.ts", count: 5 },
      ],
    };
    const sum = sumContainerStats([a, b]);
    expect(sum.fileCount).toBe(42);
    expect(sum.funcCount).toBe(140);
    expect(sum.recurringBasenames).toEqual([
      { name: "page.tsx", count: 5 }, // 3 + 2
      { name: "y.ts", count: 5 }, // tie → name asc
      { name: "x.ts", count: 2 },
    ]);
  });

  test("single part → identity; empty → zeros", () => {
    const one = {
      fileCount: 9,
      funcCount: 3,
      recurringBasenames: [{ name: "a.ts", count: 2 }],
    };
    expect(sumContainerStats([one])).toEqual(one);
    expect(sumContainerStats([])).toEqual({
      fileCount: 0,
      funcCount: 0,
      recurringBasenames: [],
    });
  });

  test("top-N cap applied after merge", () => {
    const parts = [1, 2, 3, 4, 5].map((i) => ({
      fileCount: 2,
      funcCount: 0,
      recurringBasenames: [{ name: `f${i}.ts`, count: 2 }],
    }));
    expect(sumContainerStats(parts, { topN: 3 }).recurringBasenames.length).toBe(3);
  });
});
