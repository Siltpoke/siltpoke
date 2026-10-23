// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Generated view, import check (amended after a hands-on test): an edge is solid when ANY file
 * under the two containers' folders imports the other side — not just the files the AI happened to
 * sample. The sample stays display-only. Driven through the real converters and `buildTrustMap`.
 */
import { describe, expect, it } from "bun:test";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import type { ArchitectureProjection } from "../../src/repo-graph/project-architecture";
import { generatedContainers, generatedEdges } from "../../src/repo-graph/trust-inputs";
import { buildTrustMap } from "../../src/repo-graph/trust-map";

const subdir = (id: string, files: number) => ({ id, group: "g", path: id, files, funcCount: 0, recurringBasenames: [], purpose: "", inbound: 0, outbound: 0 });
const proj: ArchitectureProjection = {
  repo: { id: "r", name: "repo", path: "~/repo", files: 9, symbols: 0, edges: 0, lastIndexedTs: "2026-09-30T00:00:00Z", building: false, groupingMode: "fallback" },
  groups: [],
  subdirs: [subdir("src/web", 3), subdir("src/state", 2), subdir("src/docs", 1), subdir("src/shared", 3)],
  edges: [],
};
const graphFiles = [
  "src/web/app.ts", "src/web/routes/critic.tsx", "src/web/util.ts",
  "src/state/api.ts", "src/state/store.ts",
  "src/docs/readme.ts",
  "src/shared/one.ts", "src/shared/two.ts", "src/shared/three.ts",
];
const cont = (id: string, members: string[]) => ({
  id, kind: "cont" as const, title: { value: id, evidence: [] }, band: { value: "b", evidence: [] }, members,
});
const verb = (value: string) => ({ value, evidence: [], tier: "inferred" as const });

type Node = ReturnType<typeof cont>;
type DocEdge = { source: string; target: string; verb: ReturnType<typeof verb> };
/** Build the Generated trust map for any projection / file list through the real converters. */
function run(p: ArchitectureProjection, files: string[], nodes: Node[], edges: DocEdge[], pairs: Array<[string, string]>) {
  const doc: ArchModelDoc = { boundary: "repo", bands: [], nodes, edges };
  return buildTrustMap({
    source: "generated",
    containers: generatedContainers(doc, p, files),
    edges: generatedEdges(doc),
    importPairs: pairs,
    citationExists: () => false,
    stamp: { mapDate: "2026-09-30T00:00:00Z", commit: null, commitsAhead: null, headRelation: "not-recorded" },
    notShown: [],
    withListedFiles: true,
  });
}

function trust(pairs: Array<[string, string]>, nodes = [
  cont("web", ["src/web/app.ts"]), // the AI sampled app.ts, NOT routes/critic.tsx
  cont("state", ["src/state/store.ts"]),
  cont("docs", ["src/docs/readme.ts"]),
], edges = [
  { source: "web", target: "state", verb: verb("reads") },
  { source: "web", target: "docs", verb: verb("links") },
]) {
  return run(proj, graphFiles, nodes, edges, pairs);
}
const edge = (t: ReturnType<typeof trust>, s: string, d: string) => t.edges.find((e) => e.source === s && e.target === d)!;

describe("Generated: the import check reads every file under the folders", () => {
  it("an import from a file the AI did not sample makes the edge solid (web → state, the real case)", () => {
    const t = trust([["src/web/routes/critic.tsx", "src/state/api.ts"]]);
    expect(edge(t, "web", "state").solid).toBe(true);
    expect(edge(t, "web", "state").evidence).toEqual({ kind: "import", count: 1 });
  });
  it("an edge with no import anywhere stays dashed", () => {
    const t = trust([["src/web/routes/critic.tsx", "src/state/api.ts"]]);
    expect(edge(t, "web", "docs").solid).toBe(false);
    expect(edge(t, "web", "docs").evidence).toEqual({ kind: "none", reason: "no-import-no-citation" });
  });
  it("the sample is still what the boxes show: listedFiles and the listed counts are unchanged", () => {
    const t = trust([]);
    const web = t.containers.find((c) => c.id === "web")!;
    expect(web.listedFiles).toEqual(["src/web/app.ts"]);
    expect(web.folders).toEqual([{ folder: "src/web", listed: 1, total: 3 }]);
  });
  it("a folder two containers both list files from: its unlisted files count for neither (no invented import)", () => {
    const nodes = [cont("x", ["src/shared/one.ts"]), cont("y", ["src/shared/two.ts", "src/state/store.ts"])];
    const edges = [{ source: "x", target: "y", verb: verb("uses") }];
    // An import between two files that are each LISTED by one side still counts…
    expect(trust([["src/shared/one.ts", "src/shared/two.ts"]], nodes, edges).edges[0].solid).toBe(true);
    // …but an unlisted file in the shared folder is nobody's: its import does not make x → y solid.
    const t = trust([["src/shared/three.ts", "src/state/api.ts"]], nodes, edges);
    expect(t.edges[0].solid).toBe(false);
  });
});

describe("Generated: files under no subdir are never handed to a box (review of faa910ff)", () => {
  // scripts/ and the top level belong to no subdir: the repo-root bucket.
  const files = [...graphFiles, "scripts/x.ts", "scripts/y.ts", "top.ts"];
  const nodes = [cont("a", ["scripts/x.ts"]), cont("b", ["src/state/store.ts"])];
  const edges = [{ source: "a", target: "b", verb: verb("runs") }];
  it("one listed root-level file does not make every unclaimed file the box's: an unlisted root file's import is not A's", () => {
    const t = run(proj, files, nodes, edges, [["scripts/y.ts", "src/state/api.ts"]]);
    expect(t.edges[0].solid).toBe(false);
    expect(t.edges[0].evidence).toEqual({ kind: "none", reason: "no-import-no-citation" });
  });
  it("control: the listed root-level file's own import still counts", () => {
    const t = run(proj, files, nodes, edges, [["scripts/x.ts", "src/state/api.ts"]]);
    expect(t.edges[0].solid).toBe(true);
  });
});

describe("Generated: which folder a file belongs to (now load-bearing)", () => {
  const p: ArchitectureProjection = {
    ...proj,
    subdirs: [subdir("src/critic", 2), subdir("src/critic/rubric", 2), subdir("src/web", 1), subdir("src/web-utils", 1), subdir("src/other", 1)],
  };
  const files = ["src/critic/run.ts", "src/critic/gate.ts", "src/critic/rubric/rules.ts", "src/critic/rubric/score.ts", "src/web/app.ts", "src/web-utils/fmt.ts", "src/other/o.ts"];
  it("a file in a nested folder counts for the nested folder's box only, not the parent's", () => {
    const nodes = [cont("critic", ["src/critic/run.ts"]), cont("rubric", ["src/critic/rubric/rules.ts"]), cont("other", ["src/other/o.ts"])];
    const edges = [{ source: "critic", target: "other", verb: verb("uses") }, { source: "rubric", target: "other", verb: verb("uses") }];
    const t = run(p, files, nodes, edges, [["src/critic/rubric/score.ts", "src/other/o.ts"]]);
    expect(t.edges.find((e) => e.source === "critic")!.solid).toBe(false); // score.ts is rubric's, not critic's
    expect(t.edges.find((e) => e.source === "rubric")!.solid).toBe(true);
  });
  it("a folder whose name only starts the same (src/web vs src/web-utils) is a different folder", () => {
    const nodes = [cont("web", ["src/web/app.ts"]), cont("other", ["src/other/o.ts"])];
    const edges = [{ source: "web", target: "other", verb: verb("uses") }];
    expect(run(p, files, nodes, edges, [["src/web-utils/fmt.ts", "src/other/o.ts"]]).edges[0].solid).toBe(false);
    // Also when src/web-utils is no subdir of its own: its file is then nobody's, not src/web's.
    const noUtils = { ...p, subdirs: p.subdirs.filter((d) => d.id !== "src/web-utils") };
    expect(run(noUtils, files, nodes, edges, [["src/web-utils/fmt.ts", "src/other/o.ts"]]).edges[0].solid).toBe(false);
  });
});
