/**
 * query.ts tests.
 */
import { test, expect, describe } from "bun:test";
import {
  resolveTarget,
  levenshteinSuggest,
  type ResolveResult,
} from "../../src/repo-graph/query";
import { buildSymbolTable } from "../../src/repo-graph/symbol-table";
import type { RepoGraph, QueryIndex } from "../../src/repo-graph/types";

function makeFixture(): {
  graph: RepoGraph;
  qi: QueryIndex;
} {
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [
      // file nodes
      {
        id: "file:src/cli/doctor.ts:",
        type: "file",
        name: "doctor.ts",
        path: "src/cli/doctor.ts",
        lineRange: [1, 200],
      },
      {
        id: "file:src/brain/schema.ts:",
        type: "file",
        name: "schema.ts",
        path: "src/brain/schema.ts",
        lineRange: [1, 100],
      },
      // function nodes
      {
        id: "function:src/cli/doctor.ts:runDoctor",
        type: "function",
        name: "runDoctor",
        path: "src/cli/doctor.ts",
        lineRange: [42, 87],
      },
      {
        id: "function:src/state/critic-event-log-parse.ts:parse",
        type: "function",
        name: "parse",
        path: "src/state/critic-event-log-parse.ts",
        lineRange: [18, 80],
      },
      {
        id: "function:src/brain/schema.ts:parse",
        type: "function",
        name: "parse",
        path: "src/brain/schema.ts",
        lineRange: [24, 56],
      },
      {
        id: "function:src/cli/doctor.ts:parse",
        type: "function",
        name: "parse",
        path: "src/cli/doctor.ts",
        lineRange: [100, 120],
      },
    ],
    edges: [],
  };
  const qi: QueryIndex = {
    schemaVersion: 1,
    name_to_node_ids: {
      runDoctor: ["function:src/cli/doctor.ts:runDoctor"],
      parse: [
        "function:src/state/critic-event-log-parse.ts:parse",
        "function:src/brain/schema.ts:parse",
        "function:src/cli/doctor.ts:parse",
      ],
    },
    path_to_node_ids: {
      "src/cli/doctor.ts": [
        "file:src/cli/doctor.ts:",
        "function:src/cli/doctor.ts:runDoctor",
        "function:src/cli/doctor.ts:parse",
      ],
      "src/brain/schema.ts": [
        "file:src/brain/schema.ts:",
        "function:src/brain/schema.ts:parse",
      ],
      "src/state/critic-event-log-parse.ts": [
        "function:src/state/critic-event-log-parse.ts:parse",
      ],
    },
  };
  return { graph, qi };
}

describe("resolveTarget — bare symbol", () => {
  test("unique bare symbol → found", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget("runDoctor", graph, st);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.node.nodeId).toBe(
        "function:src/cli/doctor.ts:runDoctor",
      );
    }
  });

  test("multi-match bare symbol → ambiguous with all candidates", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget("parse", graph, st);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.map((c) => c.path)).toEqual([
        "src/state/critic-event-log-parse.ts",
        "src/brain/schema.ts",
        "src/cli/doctor.ts",
      ]);
    }
  });

  test("not-found bare symbol → suggestions via Levenshtein", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget("paarse", graph, st);
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.suggestions).toContain("parse");
    }
  });
});

describe("resolveTarget — qualified path:symbol", () => {
  test("qualified narrows multi-match to one", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget(
      "src/brain/schema.ts:parse",
      graph,
      st,
    );
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.node.path).toBe("src/brain/schema.ts");
      expect(result.node.name).toBe("parse");
    }
  });

  test("qualified mismatch (symbol not in path) → not_found", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget(
      "src/brain/schema.ts:runDoctor",
      graph,
      st,
    );
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveTarget — file path", () => {
  test("known file path returns file node", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget("src/cli/doctor.ts", graph, st);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.node.type).toBe("file");
      expect(result.node.path).toBe("src/cli/doctor.ts");
    }
  });

  test("unknown file path → not_found", () => {
    const { graph, qi } = makeFixture();
    const st = buildSymbolTable(graph, qi);
    const result = resolveTarget("src/missing.ts", graph, st);
    expect(result.kind).toBe("not_found");
  });
});

describe("levenshteinSuggest", () => {
  test("returns top-3 closest names", () => {
    const names = ["parse", "parseInt", "parseFloat", "alpha", "beta", "Charlie"];
    const out = levenshteinSuggest("paarse", names, 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("parse");
  });

  test("exact match comes first", () => {
    const out = levenshteinSuggest("parse", ["alpha", "parse", "parsed"], 3);
    expect(out[0]).toBe("parse");
  });

  test("returns fewer than n when fewer candidates exist", () => {
    const out = levenshteinSuggest("x", ["alpha", "beta"], 5);
    expect(out).toHaveLength(2);
  });

  test("empty pool → empty result", () => {
    const out = levenshteinSuggest("x", [], 3);
    expect(out).toHaveLength(0);
  });
});
