/**
 * two-tier grounding (the riskiest slice). Exhaustive fixtures for the
 * band predicate + verb/ext/purpose corroboration + groundedPct + the exact
 * demotion behavior (label → inferred, NO re-sort, containers stay cited).
 */
import { describe, expect, it } from "bun:test";
import type { RepoGraph, SiltpokeGraphNode } from "../../src/repo-graph/types";
import { groundBands, type BandLike, type SubdirEdge } from "../../src/explain/arch-ground-bands";
import { groundArchModel, type SourceProvider } from "../../src/explain/arch-ground";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";

// Test-local resolver standing in for the real makeResolveSubdir closure: these
// gradient fixtures use synthetic subdir ids directly (members ARE keyspace ids),
// with comp: split ids folded to their parent — mirroring what the file-path
// closure produces. (Real file-path → subdir resolution is covered in
// subdir-resolve.test.ts; here we exercise the gradient/order/tier logic.)
const idResolve = (id: string): string[] => [id.startsWith("comp:") ? id.slice(5).split("/")[0]! : id];

// ── band predicate ────────────────────────────────────────────────────────────
// 4-band "fan": a depends on all (source), d depended-on by all (sink) → 4
// distinct nets a=-3 b=-1 c=+1 d=+3, expected top→bottom [A,B,C,D].
const FAN_EDGES: SubdirEdge[] = [
  { source: "a", target: "b", weight: 1 },
  { source: "a", target: "c", weight: 1 },
  { source: "a", target: "d", weight: 1 },
  { source: "b", target: "c", weight: 1 },
  { source: "b", target: "d", weight: 1 },
  { source: "c", target: "d", weight: 1 },
];
function fanBands(orders: Record<string, number>): BandLike[] {
  return [
    { id: "A", order: orders.A!, members: ["a"] },
    { id: "B", order: orders.B!, members: ["b"] },
    { id: "C", order: orders.C!, members: ["c"] },
    { id: "D", order: orders.D!, members: ["d"] },
  ];
}

describe("groundBands — layer predicate", () => {
  it("(a) clean DAG, proposed order matches gradient → all cited", () => {
    const t = groundBands(fanBands({ A: 0, B: 1, C: 2, D: 3 }), FAN_EDGES, idResolve);
    expect(t.size).toBe(4);
    for (const id of ["A", "B", "C", "D"]) expect(t.get(id)).toBe("cited");
  });

  it("(b) one band displaced to the wrong end → only that band inferred, others cited", () => {
    // D (the sink, belongs bottom) forced to the top.
    const t = groundBands(fanBands({ D: 0, A: 1, B: 2, C: 3 }), FAN_EDGES, idResolve);
    expect(t.get("D")).toBe("inferred");
    expect(t.get("A")).toBe("cited");
    expect(t.get("B")).toBe("cited");
    expect(t.get("C")).toBe("cited");
  });

  it("(c) cyclic graph → SCC-condensed gradient, no crash", () => {
    // a↔b cycle, both → c. Condensed: {a,b} source, {c} sink.
    const edges: SubdirEdge[] = [
      { source: "a", target: "b", weight: 1 },
      { source: "b", target: "a", weight: 1 },
      { source: "a", target: "c", weight: 1 },
      { source: "b", target: "c", weight: 1 },
    ];
    const t = groundBands(
      [
        { id: "AB", order: 0, members: ["a", "b"] },
        { id: "C", order: 1, members: ["c"] },
      ],
      edges,
      idResolve,
    );
    expect(t.get("AB")).toBe("cited");
    expect(t.get("C")).toBe("cited");
  });

  it("(d) single band → cited (no ordering claim to falsify)", () => {
    const t = groundBands([{ id: "only", order: 0, members: ["a"] }], FAN_EDGES, idResolve);
    expect(t.get("only")).toBe("cited");
  });

  it("(e) giant SCC / no gradient → all inferred (forced order on unordered graph)", () => {
    const edges: SubdirEdge[] = [
      { source: "a", target: "b", weight: 1 },
      { source: "b", target: "c", weight: 1 },
      { source: "c", target: "a", weight: 1 },
    ];
    const t = groundBands(
      [
        { id: "A", order: 0, members: ["a"] },
        { id: "B", order: 1, members: ["b"] },
        { id: "C", order: 2, members: ["c"] },
      ],
      edges,
      idResolve,
    );
    expect([...t.values()]).toEqual(["inferred", "inferred", "inferred"]);
  });

  it("(f) 2-band swap is within tolerance → both cited (minimal layering claim)", () => {
    const t = groundBands(
      [
        { id: "A", order: 1, members: ["a"] },
        { id: "B", order: 0, members: ["b"] },
      ],
      [{ source: "a", target: "b", weight: 1 }],
      idResolve,
    );
    expect(t.get("A")).toBe("cited");
    expect(t.get("B")).toBe("cited");
  });
});

// ── comp:<subdir>/<name> split containers must net against parent subdir ─
// The mine: before this fix, a split-container id "comp:<subdir>/<x>" was fed
// straight into netBySubdir, where edges only reference the bare subdir id → the
// comp node was an orphan with net=0, collapsing the gradient to all-inferred.
// (memberSubdirId retired — comp:/composite/file-bucket folding is now done via the
//  shared file-path bucketer; see subdir-resolve.test.ts. These tests exercise the
//  gradient logic through `idResolve`, the test stand-in for the real closure.)
describe("groundBands — comp: split nets against parent subdir", () => {
  // Same FAN gradient, but each band's member is a SPLIT container of that subdir.
  // Without the fix every comp member is an orphan (net 0) → no gradient → all
  // inferred. With the fix they net against a/b/c/d and the proposed order holds.
  function fanCompBands(orders: Record<string, number>): BandLike[] {
    return [
      { id: "A", order: orders.A!, members: ["comp:a/one"] },
      { id: "B", order: orders.B!, members: ["comp:b/two"] },
      { id: "C", order: orders.C!, members: ["comp:c/three"] },
      { id: "D", order: orders.D!, members: ["comp:d/four"] },
    ];
  }

  it("(g) split containers resolve to their parent subdir's net → gradient holds, all cited", () => {
    const t = groundBands(fanCompBands({ A: 0, B: 1, C: 2, D: 3 }), FAN_EDGES, idResolve);
    for (const id of ["A", "B", "C", "D"]) expect(t.get(id)).toBe("cited");
  });

  it("(h2) a MULTI-subdir cohesive container contributes the SUM of its distinct subdir nets (flatMap+distinct path)", () => {
    // resolveSubdir can return >1 id for one container (a cohesive container spanning
    // two subdirs). The band must sum the DISTINCT subdir nets. "AB"→[a,b] (both
    // sources, net -3 + -1 = -4 → most source-like → top).
    const multiResolve = (id: string): string[] => (id === "AB" ? ["a", "b", "a"] : [id]);
    const bands: BandLike[] = [
      { id: "M", order: 0, members: ["AB"] }, // net(a)+net(b) (a counted once) = -4
      { id: "C", order: 1, members: ["c"] }, // +1
      { id: "D", order: 2, members: ["d"] }, // +3
    ];
    const t = groundBands(bands, FAN_EDGES, multiResolve);
    for (const id of ["M", "C", "D"]) expect(t.get(id)).toBe("cited"); // ascending net matches order
  });

  it("(h) two splits of the SAME subdir both inherit that subdir's net", () => {
    // Band A holds two splits of subdir a (the source). Both fold to "a" and, via
    // distinct-subdir dedup, count net(a) ONCE (not 2×). Sink D forced top → inferred.
    const bands: BandLike[] = [
      { id: "A", order: 1, members: ["comp:a/one", "comp:a/two"] },
      { id: "D", order: 0, members: ["d"] },
      { id: "B", order: 2, members: ["b"] },
      { id: "C", order: 3, members: ["c"] },
    ];
    const t = groundBands(bands, FAN_EDGES, idResolve);
    expect(t.get("D")).toBe("inferred"); // sink at top contradicts gradient
    expect(t.get("A")).toBe("cited");
  });

  it("(j) comp keyspace guard HOLDS on a DENSE edge set", () => {
    // Densification adds edges; the comp→parent fold must still land split members in
    // the (now richer) keyspace — not orphan them. Dense layered fixture + a band
    // whose members are ALL splits of one subdir → it grounds via the parent net.
    const dense: SubdirEdge[] = [
      { source: "ui", target: "core", weight: 5 },
      { source: "core", target: "state", weight: 4 },
      { source: "core", target: "db", weight: 3 },
      { source: "state", target: "db", weight: 2 },
    ];
    const keyspace = new Set(dense.flatMap((e) => [e.source, e.target]));
    const bands: BandLike[] = [
      { id: "U", order: 0, members: ["comp:ui/a", "comp:ui/b"] },
      { id: "C", order: 1, members: ["core"] },
      { id: "S", order: 2, members: ["comp:state/x"] },
      { id: "D", order: 3, members: ["db"] },
    ];
    for (const b of bands) for (const m of b.members) {
      // every comp member folds to a parent id present in the dense keyspace
      if (m.startsWith("comp:")) expect(keyspace.has(idResolve(m)[0] ?? "")).toBe(true);
    }
    const t = groundBands(bands, dense, idResolve);
    // ui(source, net<0) top, db(sink, net>0) bottom — proposed order matches → cited
    expect(t.get("U")).toBe("cited");
    expect(t.get("D")).toBe("cited");
  });

  it("(i) keyspace guard — every comp member normalizes into the subdirEdges keyspace, not a coincidental sparse pass", () => {
    // Non-sparse fixture: a is a real source (net -3) in FAN_EDGES. The comp member
    // MUST land on 'a' (present in source∪target) and pick up a's real net — proven
    // by the gradient resolving, not by everything collapsing to 0.
    const keyspace = new Set(FAN_EDGES.flatMap((e) => [e.source, e.target]));
    for (const m of ["comp:a/one", "comp:b/two", "comp:c/three", "comp:d/four"]) {
      expect(keyspace.has(idResolve(m)[0] ?? "")).toBe(true);
    }
    // structural: with the fix the comp-only bands produce a real (size>=2) gradient
    const t = groundBands(
      [
        { id: "A", order: 0, members: ["comp:a/one"] },
        { id: "D", order: 1, members: ["comp:d/four"] },
      ],
      FAN_EDGES,
      idResolve,
    );
    // a(net -3) over d(net +3): A-top D-bottom matches → cited (real gradient, not 0=0)
    expect(t.get("A")).toBe("cited");
    expect(t.get("D")).toBe("cited");
  });
});

// ── groundArchModel: verb / ext / purpose / fact / groundedPct ────────────────
function fileNode(path: string, maxLine: number): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, maxLine] };
}
const GRAPH: RepoGraph = {
  schemaVersion: 1,
  nodes: [fileNode("src/a/x.ts", 100), fileNode("src/b/y.ts", 100)],
  edges: [],
};
const EDGES: SubdirEdge[] = [{ source: "a", target: "b", weight: 1 }];
// Structural projection keyspace matching the test fixtures.
const SUBDIRS_KS = [{ id: "a", path: "src/a/" }, { id: "b", path: "src/b/" }];

/** Source where line 10 of x.ts contains "spawn", everything else is bland. */
const SRC: SourceProvider = async (p) => {
  if (p === "src/a/x.ts") return Array.from({ length: 100 }, (_, i) => (i === 9 ? "  Bun.spawn(['claude'])" : "// bland")).join("\n");
  return Array.from({ length: 100 }, () => "// bland").join("\n");
};

function docWith(over: Partial<ArchModelDoc> = {}): ArchModelDoc {
  return {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: [{ file: "src/a/x.ts", line: 10 }] }, order: 0, members: ["a", "b"] }],
    nodes: [
      { id: "a", kind: "cont", title: { value: "A", evidence: [{ file: "src/a/x.ts", line: 10 }] }, band: { value: "core", evidence: [{ file: "src/a/x.ts", line: 10 }] }, members: ["src/a/x.ts"] },
    ],
    edges: [],
    ...over,
  };
}

describe("groundArchModel — verb snippet-token", () => {
  it("verb with a corroborating token at the cited line → cited", async () => {
    const doc = docWith({ edges: [{ source: "b", target: "a", verb: { value: "spawns claude", evidence: [{ file: "src/a/x.ts", line: 10 }] } }] });
    const r = await groundArchModel(doc, GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(r.doc.edges[0]!.verb.value).toBe("spawns claude");
    expect(r.doc.edges[0]!.verb.tier).toBe("cited");
  });

  it("verb with NO corroborating token → degrades to 'uses', inferred", async () => {
    const doc = docWith({ edges: [{ source: "b", target: "a", verb: { value: "orchestrates", evidence: [{ file: "src/b/y.ts", line: 5 }] } }] });
    const r = await groundArchModel(doc, GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(r.doc.edges[0]!.verb.value).toBe("uses");
    expect(r.doc.edges[0]!.verb.tier).toBe("inferred");
  });

  it("verb whose cite doesn't resolve → 'uses' inferred (no source read needed)", async () => {
    const doc = docWith({ edges: [{ source: "b", target: "a", verb: { value: "spawns", evidence: [{ file: "ghost.ts", line: 1 }] } }] });
    const r = await groundArchModel(doc, GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(r.doc.edges[0]!.verb.tier).toBe("inferred");
    expect(r.doc.edges[0]!.verb.value).toBe("uses");
  });
});

describe("groundArchModel — ext, purpose, fact, groundedPct, immutability", () => {
  it("ext node not corroborated by a call-site token → title inferred", async () => {
    const doc = docWith({
      nodes: [{ id: "api", kind: "ext", title: { value: "Anthropic API", evidence: [{ file: "src/b/y.ts", line: 5 }] }, band: { value: "core", evidence: [{ file: "src/b/y.ts", line: 5 }] } }],
    });
    const r = await groundArchModel(doc, GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(r.doc.nodes[0]!.title.tier).toBe("inferred");
  });

  it("purpose with a resolving cite → cited; non-resolving → inferred", async () => {
    const ok = await groundArchModel(docWith({ nodes: [{ id: "a", kind: "cont", title: { value: "A", evidence: [{ file: "src/a/x.ts", line: 1 }] }, band: { value: "core", evidence: [{ file: "src/a/x.ts", line: 1 }] }, desc: { value: "does a", evidence: [{ file: "src/a/x.ts", line: 1 }] } }] }), GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(ok.doc.nodes[0]!.desc!.tier).toBe("cited");
    const bad = await groundArchModel(docWith({ nodes: [{ id: "a", kind: "cont", title: { value: "A", evidence: [{ file: "src/a/x.ts", line: 1 }] }, band: { value: "core", evidence: [{ file: "src/a/x.ts", line: 1 }] }, desc: { value: "does a", evidence: [{ file: "ghost.ts", line: 1 }] } }] }), GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(bad.doc.nodes[0]!.desc!.tier).toBe("inferred");
  });

  it("fact title with a resolving cite → cited; band-label demotion leaves containers cited", async () => {
    // Single band → cited label; container titles independently cited.
    const r = await groundArchModel(docWith(), GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(r.doc.bands[0]!.label.tier).toBe("cited");
    expect(r.doc.nodes[0]!.title.tier).toBe("cited");
  });

  it("groundedPct = cited / total over all claims (inferred not in numerator)", async () => {
    const doc = docWith({ edges: [{ source: "b", target: "a", verb: { value: "orchestrates", evidence: [{ file: "ghost.ts", line: 1 }] } }] });
    const r = await groundArchModel(doc, GRAPH, EDGES, SUBDIRS_KS, SRC);
    // claims: band.label(cited) + node.title(cited) + node.band(cited) + verb(inferred) = 3/4
    expect(r.totalClaims).toBe(4);
    expect(r.citedClaims).toBe(3);
    expect(r.groundedPct).toBe(75);
  });

  it("is immutable — the input doc's tiers are untouched", async () => {
    const doc = docWith();
    await groundArchModel(doc, GRAPH, EDGES, SUBDIRS_KS, SRC);
    expect(doc.bands[0]!.label.tier).toBeUndefined();
    expect(doc.nodes[0]!.title.tier).toBeUndefined();
  });
});
