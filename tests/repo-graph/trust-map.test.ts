import { describe, expect, it } from "bun:test";
import { buildTrustMap, type TrustInput } from "../../src/repo-graph/trust-map";

const stamp = { mapDate: "2026-09-20T00:00:00Z", commit: null, commitsAhead: null, headRelation: "not-recorded" as const };
const base = (over: Partial<TrustInput> = {}): TrustInput => ({
  source: "generated",
  containers: [
    { id: "a", title: "A", desc: "", importFiles: ["src/a/x.ts"], folders: [{ folder: "src/a", listed: 1, total: 4 }], listedFiles: ["src/a/x.ts"] },
    { id: "b", title: "B", desc: "", importFiles: ["src/b/y.ts"], folders: [{ folder: "src/b", listed: 1, total: 2 }], listedFiles: ["src/b/y.ts"] },
  ],
  edges: [{ source: "a", target: "b", verb: "uses", tier: "inferred", citation: null }],
  importPairs: [],
  citationExists: () => false,
  stamp, notShown: [], withListedFiles: false,
  ...over,
});

describe("edge classification (AC6-AC8)", () => {
  it("import in either direction → solid import", () => {
    const t = buildTrustMap(base({ importPairs: [["src/b/y.ts", "src/a/x.ts"]] }));
    expect(t.edges[0]).toMatchObject({ solid: true, evidence: { kind: "import", count: 1 } });
  });
  it("import wins over a citation", () => {
    const t = buildTrustMap(base({ importPairs: [["src/a/x.ts", "src/b/y.ts"]],
      edges: [{ source: "a", target: "b", verb: "uses", tier: "cited", citation: { file: "src/a/x.ts", line: 3 } }], citationExists: () => true }));
    expect(t.edges[0].evidence.kind).toBe("import");
  });
  it("cited + still resolves → solid cited", () => {
    const t = buildTrustMap(base({ edges: [{ source: "a", target: "b", verb: "calls", tier: "cited", citation: { file: "web/api.ts", line: 40 } }], citationExists: () => true }));
    expect(t.edges[0]).toMatchObject({ solid: true, evidence: { kind: "cited", file: "web/api.ts", line: 40 } });
  });
  it("cited but gone → dashed citation-stale", () => {
    const t = buildTrustMap(base({ edges: [{ source: "a", target: "b", verb: "calls", tier: "cited", citation: { file: "gone.ts", line: 1 } }] }));
    expect(t.edges[0]).toMatchObject({ solid: false, evidence: { kind: "none", reason: "citation-stale" } });
  });
  it("inferred / topology-blind without import → dashed", () => {
    for (const tier of ["inferred", "topology-blind", null] as const) {
      const t = buildTrustMap(base({ edges: [{ source: "a", target: "b", verb: "x", tier, citation: { file: "src/a/x.ts", line: 1 } }], citationExists: () => true }));
      expect(t.edges[0]).toMatchObject({ solid: false, evidence: { kind: "none", reason: "no-import-no-citation" } });
    }
  });
  it("subset edges carry their weight as import count", () => {
    const t = buildTrustMap(base({ source: "subset", edges: [{ source: "a", target: "b", verb: "", tier: null, citation: null, subsetWeight: 12 }] }));
    expect(t.edges[0].evidence).toEqual({ kind: "import", count: 12 });
  });
});

describe("containers + totals (AC9-AC11, AC17)", () => {
  it("strips listedFiles unless asked", () => {
    expect(buildTrustMap(base()).containers[0].listedFiles).toEqual([]);
    expect(buildTrustMap(base({ withListedFiles: true })).containers[0].listedFiles).toEqual(["src/a/x.ts"]);
  });
  it("totals only on generated, summed over distinct folders", () => {
    expect(buildTrustMap(base()).totals).toEqual({ listed: 2, total: 6 });
    expect(buildTrustMap(base({ source: "authored" })).totals).toBeNull();
  });
  it("empty map is valid (Review Focus 2)", () => {
    const t = buildTrustMap(base({ containers: [], edges: [] }));
    expect(t).toMatchObject({ containers: [], edges: [], totals: { listed: 0, total: 0 } });
  });
});

describe("path guard via buildTrustMap (spec §5, Review Focus 4)", () => {
  it.each([
    ["src/x.ts", "src/x.ts"], ["./src/x.ts", "src/x.ts"], ["src\\win\\x.ts", "src/win/x.ts"],
    ["/Users/v/repo/x.ts", "<outside repo>"], ["/opt/x", "<outside repo>"], ["C:\\repo\\x.ts", "<outside repo>"],
    ["C:/repo/x.ts", "<outside repo>"], ["\\\\srv\\share\\x", "<outside repo>"], ["../x.ts", "<outside repo>"], ["src/../../x", "<outside repo>"],
  ])("%s → %s", (i, o) => expect(buildTrustMap(base({ notShown: [i] })).notShown[0]).toBe(o));
  it("guards every path field in the output", () => {
    const t = buildTrustMap(base({ withListedFiles: true, notShown: ["/abs/dir"],
      containers: [{ id: "a", title: "A", desc: "", importFiles: [], folders: [{ folder: "/abs", listed: 1, total: 1 }], listedFiles: ["/Users/x/secret.ts"] }] }));
    expect(JSON.stringify(t)).not.toMatch(/\/Users\/|"\/abs/);
  });
});

// Q2 golden cases: the 8
// cited-but-no-import edges from the measurement, hand-classified there as 3
// sample-gap imports (real import invisible because the connecting file is outside
// the LLM's member sample) + 3 cross-language (TS → Django, can never be an import)
// + 1 __init__ re-export (a real Python import the resolver DOES recover as an
// import pair) + 1 dead citation (cited file deleted by a later PR).
describe("Q2 golden cases", () => {
  const citedEdge = (file: string, line: number) =>
    base({
      edges: [{ source: "a", target: "b", verb: "calls", tier: "cited" as const, citation: { file, line } }],
      citationExists: () => true,
    });

  it.each([
    ["src/a/sample-gap-1.ts", 10],
    ["src/a/sample-gap-2.ts", 20],
    ["src/a/sample-gap-3.ts", 30],
  ])("sample-gap import %s:%d → solid cited (citation recovers what the member sample missed)", (file, line) => {
    const t = buildTrustMap(citedEdge(file, line));
    expect(t.edges[0]).toMatchObject({ solid: true, evidence: { kind: "cited", file, line } });
  });

  it.each([
    ["web/frontend/api-client.ts", 12],
    ["web/frontend/orders.ts", 8],
    ["web/frontend/billing.ts", 21],
  ])("cross-language HTTP call %s:%d → solid cited (can never be an import)", (file, line) => {
    const t = buildTrustMap(citedEdge(file, line));
    expect(t.edges[0]).toMatchObject({ solid: true, evidence: { kind: "cited", file, line } });
  });

  it("Python __init__ re-export recovered via a real import pair → solid import", () => {
    const t = buildTrustMap(
      base({
        containers: [
          { id: "a", title: "A", desc: "", importFiles: ["pkg/a/mod.py"], folders: [{ folder: "pkg/a", listed: 1, total: 1 }], listedFiles: ["pkg/a/mod.py"] },
          { id: "b", title: "B", desc: "", importFiles: ["pkg/b/__init__.py"], folders: [{ folder: "pkg/b", listed: 1, total: 1 }], listedFiles: ["pkg/b/__init__.py"] },
        ],
        edges: [{ source: "a", target: "b", verb: "imports", tier: "cited", citation: { file: "pkg/a/mod.py", line: 1 } }],
        importPairs: [["pkg/a/mod.py", "pkg/b/__init__.py"]],
        citationExists: () => true,
      }),
    );
    expect(t.edges[0]).toMatchObject({ solid: true, evidence: { kind: "import", count: 1 } });
  });

  it("dead citation (file deleted by a later PR) → dashed citation-stale", () => {
    const t = buildTrustMap(
      base({
        edges: [{ source: "a", target: "b", verb: "calls", tier: "cited", citation: { file: "src/a/deleted-by-later-pr.ts", line: 5 } }],
        citationExists: () => false,
      }),
    );
    expect(t.edges[0]).toMatchObject({ solid: false, evidence: { kind: "none", reason: "citation-stale" } });
  });
});
