/** Files at the repo root reach the Generate prompt.
 *
 * agent-runtime shape: `main.py` beside `utils/`. Before the root container
 * existed, `main.py` belonged to no subdir, so `assembleArchContext` never put
 * its symbols in front of the model — the Generated view could not draw it.
 * Then, once the root container existed, its path "" was falsy and the owner
 * check dropped it again; both halves are pinned here.
 */
import { describe, expect, it } from "bun:test";
import { aggregateBySuperGroup } from "../../src/repo-graph/aggregator";
import { projectArchitecture } from "../../src/repo-graph/project-architecture";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";
import { emptyCounters } from "../../src/repo-graph/types";
import { assembleArchContext } from "../../src/explain/arch-context";

function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 80] };
}
function fnNode(path: string, name: string): SiltpokeGraphNode {
  return { id: `function:${path}:${name}`, type: "function", name, path, lineRange: [3, 9], signature: `def ${name}()` };
}
function meta(): RepoGraphMeta {
  return {
    schemaVersion: 1, project_root: "/tmp/agent-runtime", proj_hash: "rootctx00000",
    last_indexed_ts: "2026-10-15T00:00:00Z", build_duration_ms: 1, counters: emptyCounters(),
  };
}

function contextFor(graph: RepoGraph): string {
  const aggregated = aggregateBySuperGroup(graph, null);
  const projection = projectArchitecture(graph, null, meta());
  return assembleArchContext(graph, aggregated, projection).contextBundle;
}

describe("assembleArchContext — repo-root files", () => {
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [
      fileNode("main.py"),
      fnNode("main.py", "run_agent_loop"),
      fileNode("utils/helpers.py"),
      fnNode("utils/helpers.py", "parse_llm_decision"),
    ],
    edges: [],
  };
  const ctx = contextFor(graph);

  it("puts a root file's symbols in front of the model", () => {
    expect(ctx).toContain("run_agent_loop");
  });

  it("labels the root block (root) and keeps the file path whole", () => {
    expect(ctx).toContain("### (root)");
    expect(ctx).toContain("#### main.py");
  });

  it("still files a nested symbol under its own subdir, not the root", () => {
    const rootBlock = ctx.slice(ctx.indexOf("### (root)"));
    const end = rootBlock.indexOf("\n### ", 1);
    const onlyRoot = end < 0 ? rootBlock : rootBlock.slice(0, end);
    expect(onlyRoot).not.toContain("parse_llm_decision");
    expect(ctx).toContain("### utils/");
  });
});
