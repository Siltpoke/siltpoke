/**
 * entrypoint detection.
 *
 * The trace layer roots each path at a REAL resolved symbol. We use an
 * ordered allow-list per role (CLI Stop hook / daemon server / dashboard
 * render) and only emit a role when one of its candidate symbols actually
 * exists as a function/class node in the graph.
 */
import { test, expect, describe } from "bun:test";
import { detectEntrypoints } from "../../src/repo-graph/detect-entrypoints";
import { emptyGraph, emptyQueryIndex } from "../../src/repo-graph/types";
import type { RepoGraph, QueryIndex, SiltpokeNodeType } from "../../src/repo-graph/types";

function add(
  graph: RepoGraph,
  queryIndex: QueryIndex,
  type: SiltpokeNodeType,
  path: string,
  name: string,
  line: number,
) {
  const id = `${type}:${path}:${name}`;
  graph.nodes.push({ id, type, name, path, lineRange: [line, line + 5] });
  queryIndex.name_to_node_ids[name] ??= [];
  queryIndex.name_to_node_ids[name].push(id);
  queryIndex.path_to_node_ids[path] ??= [];
  queryIndex.path_to_node_ids[path].push(id);
}

describe("detectEntrypoints", () => {
  test("detects the three real siltpoke roots from resolved symbols", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    add(graph, queryIndex, "function", "src/hooks/handle-stop.ts", "handleStopHook", 90);
    add(graph, queryIndex, "function", "src/daemon/server.ts", "startDaemon", 128);
    add(graph, queryIndex, "function", "src/web/screens/Home.tsx", "Home", 35);

    const eps = detectEntrypoints(graph, queryIndex);
    const byId = new Map(eps.map((e) => [e.id, e]));

    expect(byId.get("cli")).toMatchObject({
      fn: "handleStopHook",
      module: "hooks",
      file: "handle-stop.ts",
      line: 90,
      nodeId: "function:src/hooks/handle-stop.ts:handleStopHook",
    });
    expect(byId.get("daemon")?.fn).toBe("startDaemon");
    expect(byId.get("daemon")?.module).toBe("daemon");
    expect(byId.get("dash")?.fn).toBe("Home");
    expect(byId.get("dash")?.module).toBe("web");
  });

  test("omits a role whose candidate symbols don't exist", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    add(graph, queryIndex, "function", "src/hooks/handle-stop.ts", "handleStopHook", 90);
    const eps = detectEntrypoints(graph, queryIndex);
    expect(eps.map((e) => e.id)).toEqual(["cli"]);
  });

  test("falls back through the candidate name list (startServer if no startDaemon)", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    add(graph, queryIndex, "function", "src/daemon/server.ts", "startServer", 18);
    const eps = detectEntrypoints(graph, queryIndex);
    expect(eps.map((e) => e.id)).toEqual(["daemon"]);
    expect(eps[0]?.fn).toBe("startServer");
  });

  test("prefers the candidate node whose path matches the role's module hint", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    // Two `Home` symbols; the web one should win for the dash role.
    add(graph, queryIndex, "function", "src/cli/Home.ts", "Home", 1);
    add(graph, queryIndex, "function", "src/web/screens/Home.tsx", "Home", 35);
    const eps = detectEntrypoints(graph, queryIndex);
    expect(eps.find((e) => e.id === "dash")?.file).toBe("Home.tsx");
  });

  test("dash role prefers the Dashboard shell over the Home screen when both exist", () => {
    // The dash names list is ordered ["Dashboard", "Home", ...] so the SSR shell
    // (the semantic render root, less of a leaf) wins over a single screen.
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    add(graph, queryIndex, "function", "src/web/screens/Home.tsx", "Home", 35);
    add(graph, queryIndex, "function", "src/web/shells/Dashboard.tsx", "Dashboard", 12);
    const eps = detectEntrypoints(graph, queryIndex);
    expect(eps.find((e) => e.id === "dash")?.fn).toBe("Dashboard");
  });

  test("dash falls back to Home when no Dashboard shell exists", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    add(graph, queryIndex, "function", "src/web/screens/Home.tsx", "Home", 35);
    const eps = detectEntrypoints(graph, queryIndex);
    expect(eps.find((e) => e.id === "dash")?.fn).toBe("Home");
  });

  test("returns empty when nothing matches", () => {
    expect(detectEntrypoints(emptyGraph(), emptyQueryIndex())).toEqual([]);
  });
});
