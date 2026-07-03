/**
 * anchor-context resolver tests.
 *
 * Tests the pure core `assembleAnchorContext` with in-memory graph fixtures
 * (no disk), mirroring tests/repo-graph/subgraph.test.ts. Verifies the no-feed
 * core: a node id → Brain-ready context, with the dead-anchor + fingerprint
 * substrate.
 */
import { test, expect, describe } from "bun:test";
import {
  assembleAnchorContext,
  CHAT_ANCHOR_SYSTEM_PROMPT,
} from "../../src/chat/anchor-context";
import type {
  RepoGraph,
  QueryIndex,
  Fingerprints,
  SiltpokeGraphNode,
  SiltpokeGraphEdge,
} from "../../src/repo-graph/types";

function makeNode(
  id: string,
  type: SiltpokeGraphNode["type"],
  name: string,
  path: string,
  startLine = 1,
  endLine = 10,
): SiltpokeGraphNode {
  return { id, type, name, path, lineRange: [startLine, endLine] };
}

function makeEdge(
  source: string,
  target: string,
  type: SiltpokeGraphEdge["type"],
): SiltpokeGraphEdge {
  return { id: `${source}::${type}::${target}`, source, target, type, weight: 1 };
}

const FILE = "file:src/foo.ts:";
const FN = "function:src/foo.ts:applyDiscount";

function fixtureGraph(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [
      makeNode(FILE, "file", "foo.ts", "src/foo.ts", 1, 40),
      makeNode(FN, "function", "applyDiscount", "src/foo.ts", 10, 22),
    ],
    edges: [makeEdge(FILE, FN, "contains")],
  };
}

function fixtureQueryIndex(): QueryIndex {
  return {
    schemaVersion: 1,
    name_to_node_ids: { applyDiscount: [FN], "foo.ts": [FILE] },
    path_to_node_ids: { "src/foo.ts": [FILE, FN] },
  };
}

function fixtureFingerprints(): Fingerprints {
  return {
    schemaVersion: 1,
    files: { "src/foo.ts": { content_sha256: "sha-foo-123", ast_sig: "ast-foo" } },
  };
}

const SRC = "export function applyDiscount(p: number, pct: number) {\n  return p * (1 - pct);\n}\n";
const sourceProvider = async (path: string): Promise<string | null> =>
  path === "src/foo.ts" ? SRC : null;

describe("assembleAnchorContext", () => {
  test("resolved: known node id → Brain-ready context + chat system prompt", async () => {
    const res = await assembleAnchorContext({
      target: { node_id: FN },
      graph: fixtureGraph(),
      queryIndex: fixtureQueryIndex(),
      fingerprints: fixtureFingerprints(),
      sourceProvider,
    });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    const c = res.context;
    expect(c.nodeId).toBe(FN);
    expect(c.nodeName).toBe("applyDiscount");
    expect(c.nodeType).toBe("function");
    expect(c.path).toBe("src/foo.ts");
    expect(c.systemPrompt).toBe(CHAT_ANCHOR_SYSTEM_PROMPT);
    // the assembled context bundle carries the node's real SOURCE BODY — this is
    // the no-feed premise: the user never pasted this, the resolver pulled it.
    // (assert a body token, not just the name — the name can appear in a header.)
    expect(c.contextBundle).toContain("return p * (1 - pct)");
    expect(c.includedSources).toContain("src/foo.ts");
  });

  test("fingerprint = file-level content hash at pin time", async () => {
    const res = await assembleAnchorContext({
      target: { node_id: FN },
      graph: fixtureGraph(),
      queryIndex: fixtureQueryIndex(),
      fingerprints: fixtureFingerprints(),
      sourceProvider,
    });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.context.fingerprint).toBe("sha-foo-123");
  });

  test("fingerprint null when the node's file is not fingerprint-tracked", async () => {
    const res = await assembleAnchorContext({
      target: { node_id: FN },
      graph: fixtureGraph(),
      queryIndex: fixtureQueryIndex(),
      fingerprints: { schemaVersion: 1, files: {} },
      sourceProvider,
    });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.context.fingerprint).toBeNull();
  });

  test("unknown node id → node_not_found (dead anchor)", async () => {
    const res = await assembleAnchorContext({
      target: { node_id: "function:src/foo.ts:ghostFn" },
      graph: fixtureGraph(),
      queryIndex: fixtureQueryIndex(),
      fingerprints: fixtureFingerprints(),
      sourceProvider,
    });
    expect(res.kind).toBe("node_not_found");
  });

  test("descriptor {name, path} resolves to the canonical node (option b)", async () => {
    // mirrors the symbol-drill case: the client only has the render id + name +
    // file path, NOT the canonical graph id. Backend resolves it from the graph.
    const res = await assembleAnchorContext({
      target: { name: "applyDiscount", path: "src/foo.ts", node_type: "function" },
      graph: fixtureGraph(),
      queryIndex: fixtureQueryIndex(),
      fingerprints: fixtureFingerprints(),
      sourceProvider,
    });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.context.nodeId).toBe(FN); // resolved to the canonical id
    expect(res.context.contextBundle).toContain("return p * (1 - pct)");
  });

  test("descriptor with no graph match → node_not_found", async () => {
    const res = await assembleAnchorContext({
      target: { name: "ghostFn", path: "src/foo.ts" },
      graph: fixtureGraph(),
      queryIndex: fixtureQueryIndex(),
      fingerprints: fixtureFingerprints(),
      sourceProvider,
    });
    expect(res.kind).toBe("node_not_found");
  });

  test("name+path non-unique → prefers the non-file node (the clicked symbol)", async () => {
    // a file node and a function node sharing name+path is contrived, but proves
    // the disambiguation rule deterministically prefers the symbol.
    const g = fixtureGraph();
    g.nodes.push(makeNode("file:src/foo.ts:dup", "file", "applyDiscount", "src/foo.ts"));
    const res = await assembleAnchorContext({
      target: { name: "applyDiscount", path: "src/foo.ts" },
      graph: g,
      queryIndex: fixtureQueryIndex(),
      fingerprints: fixtureFingerprints(),
      sourceProvider,
    });
    expect(res.kind).toBe("resolved");
    if (res.kind !== "resolved") return;
    expect(res.context.nodeType).toBe("function");
  });
});
