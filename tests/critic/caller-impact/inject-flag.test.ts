import { afterEach, describe, expect, test } from "bun:test";
import {
  GrepCallerResolver,
  type SearchFn,
} from "../../../src/critic/caller-impact/caller-resolver.ts";
import { GraphCallerResolver } from "../../../src/critic/caller-impact/caller-resolver-graph.ts";
import {
  graphThenGrep,
  selectResolver,
} from "../../../src/critic/caller-impact/inject.ts";

const SAVED = process.env.SILTPOKE_CALLER_RESOLVER;

afterEach(() => {
  if (SAVED === undefined) delete process.env.SILTPOKE_CALLER_RESOLVER;
  else process.env.SILTPOKE_CALLER_RESOLVER = SAVED;
});

describe("selectResolver — flag wiring (graph is NOT the default)", () => {
  test("unset flag ⇒ GrepCallerResolver (default)", () => {
    delete process.env.SILTPOKE_CALLER_RESOLVER;
    expect(selectResolver()).toBeInstanceOf(GrepCallerResolver);
  });

  test("flag=grep ⇒ GrepCallerResolver", () => {
    process.env.SILTPOKE_CALLER_RESOLVER = "grep";
    expect(selectResolver()).toBeInstanceOf(GrepCallerResolver);
  });

  test("unknown flag value ⇒ GrepCallerResolver (default)", () => {
    process.env.SILTPOKE_CALLER_RESOLVER = "banana";
    expect(selectResolver()).toBeInstanceOf(GrepCallerResolver);
  });

  test("flag=graph ⇒ a graph-then-grep wrapper (not a bare Grep)", () => {
    process.env.SILTPOKE_CALLER_RESOLVER = "graph";
    const r = selectResolver();
    // The wrapper is neither a bare GrepCallerResolver nor a bare graph resolver.
    expect(r).not.toBeInstanceOf(GrepCallerResolver);
    expect(r).not.toBeInstanceOf(GraphCallerResolver);
  });
});

describe("graphThenGrep — fallback when graph is unavailable", () => {
  test("graph unavailable ⇒ grep runs and its result is returned", async () => {
    const graph = new GraphCallerResolver({ load: () => null }); // always unavailable
    // grep with an injected search that returns one cross-file caller.
    const search: SearchFn = async () => ({
      matches: [{ file: "src/bar.ts", line: 9, text: "doThing()" }],
      ok: true,
    });
    const grep = new GrepCallerResolver(search);
    const wrapped = graphThenGrep(graph, grep);

    const res = await wrapped.resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.unavailable).toBe(false);
    expect(res.callers).toEqual([{ file: "src/bar.ts", line: 9 }]);
  });

  test("graph available ⇒ graph result wins; grep never consulted", async () => {
    let grepCalled = false;
    const graph = new GraphCallerResolver({
      load: () => ({
        graph: {
          schemaVersion: 1,
          nodes: [
            {
              id: "function:src/c.ts:useIt",
              type: "function",
              name: "useIt",
              path: "src/c.ts",
              lineRange: [3, 8],
            },
          ],
          edges: [
            {
              id: "function:src/c.ts:useIt::calls::doThing",
              source: "function:src/c.ts:useIt",
              target: "doThing",
              type: "calls",
              weight: 1,
            },
          ],
        },
        queryIndex: {
          schemaVersion: 1,
          name_to_node_ids: { useIt: ["function:src/c.ts:useIt"] },
          path_to_node_ids: { "src/c.ts": ["function:src/c.ts:useIt"] },
        },
        lastIndexedTs: "2026-06-14T00:00:00.000Z",
        projectRoot: "/repo",
        storageDir: "/storage",
        stale: false,
      }),
    });
    const search: SearchFn = async () => {
      grepCalled = true;
      return { matches: [], ok: true };
    };
    const grep = new GrepCallerResolver(search);
    const wrapped = graphThenGrep(graph, grep);

    const res = await wrapped.resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.unavailable).toBe(false);
    expect(res.callers).toEqual([{ file: "src/c.ts", line: 3 }]);
    expect(grepCalled).toBe(false);
  });
});
