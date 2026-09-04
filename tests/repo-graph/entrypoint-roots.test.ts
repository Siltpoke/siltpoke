// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect, describe } from "bun:test";
import { resolveEntryRoot } from "../../src/repo-graph/entrypoint-roots";
import { emptyGraph, emptyQueryIndex } from "../../src/repo-graph/types";
import type { RepoGraph, QueryIndex, SiltpokeNodeType } from "../../src/repo-graph/types";

function addNode(g: RepoGraph, qi: QueryIndex, type: SiltpokeNodeType, path: string, name: string, line: number, exported = false) {
  const id = `${type}:${path}:${name}`;
  g.nodes.push({ id, type, name, path, lineRange: [line, line + 3], exported });
  qi.name_to_node_ids[name] ??= []; qi.name_to_node_ids[name].push(id);
  qi.path_to_node_ids[path] ??= []; qi.path_to_node_ids[path].push(id);
  return id;
}
function addFile(g: RepoGraph, qi: QueryIndex, path: string) {
  return addNode(g, qi, "file", path, "", 1);
}
function addCall(g: RepoGraph, source: string, calleeName: string) {
  g.edges.push({ id: `${source}::calls::${calleeName}`, source, target: calleeName, type: "calls", weight: 1, call_kind: "static" });
}

describe("resolveEntryRoot", () => {
  test("tier 1: prefers the exported default/main function over the file node", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    addFile(g, qi, "src/server.ts");
    const mainId = addNode(g, qi, "function", "src/server.ts", "main", 10, true);
    const pick = resolveEntryRoot(g, qi, "src/server.ts");
    expect(pick).toMatchObject({ nodeId: mainId, tier: 1 });
  });

  test("tier 2: file node when no exported symbol but a module-level in-repo call exists", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    const fileId = addFile(g, qi, "src/boot.ts");
    addNode(g, qi, "function", "src/lib/start.ts", "startServer", 5, true); // in-repo callee
    addCall(g, fileId, "startServer"); // module-level call from the file node
    const pick = resolveEntryRoot(g, qi, "src/boot.ts");
    expect(pick).toMatchObject({ nodeId: fileId, tier: 2 });
  });

  test("tier 3: shallow file-node leaf when the only export is an uncalled component", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    const fileId = addFile(g, qi, "app/page.tsx");
    // Next page default export is a component, but nothing calls it in-repo AND it is not
    // an exported rootable *function* the selector treats as tier-1 (see selection rule).
    const pick = resolveEntryRoot(g, qi, "app/page.tsx");
    expect(pick).toMatchObject({ nodeId: fileId, tier: 3 });
  });

  test("multiple non-convention exports → NOT tier 1 (falls to the file node, no arbitrary helper)", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    const fileId = addFile(g, qi, "src/util.ts");
    addNode(g, qi, "function", "src/util.ts", "helperA", 3, true);
    addNode(g, qi, "function", "src/util.ts", "helperB", 8, true);
    const pick = resolveEntryRoot(g, qi, "src/util.ts");
    expect(pick?.nodeId).toBe(fileId); // dropped to file node, did NOT root at helperA/B
    expect(pick?.tier).not.toBe(1);
  });

  test("single exported rootable (non-convention) IS tier 1", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    addFile(g, qi, "src/solo.ts");
    const only = addNode(g, qi, "function", "src/solo.ts", "runThing", 3, true);
    expect(resolveEntryRoot(g, qi, "src/solo.ts")).toMatchObject({ nodeId: only, tier: 1 });
  });

  test("returns null when the entry file is not indexed", () => {
    const g = emptyGraph(); const qi = emptyQueryIndex();
    expect(resolveEntryRoot(g, qi, "src/ghost.ts")).toBeNull();
  });
});
