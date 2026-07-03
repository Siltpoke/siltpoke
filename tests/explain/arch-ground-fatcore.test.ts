/**
 * Conflict-guarded `topology-blind` third tier.
 *
 * Detection = omnipresent-SHAPE (I≤θ_I, in≥θ_in, ALL band members) AND the
 * existing demote-conflict (LLM order contradicts the net-degree gradient). The
 * conflict is the discriminator topology lacks (pure I can't separate a
 * domain core from a real infra sink). A hub-shaped `core` (in=132, out=2,
 * I=0.015) the LLM places HIGH while the gradient says bottom → topology-blind,
 * NOT inferred (honest abstention). No exclusion (Route A).
 */
import { describe, expect, it } from "bun:test";
import { groundBands, type BandLike, type SubdirEdge } from "../../src/explain/arch-ground-bands";
import { groundArchModel, type SourceProvider } from "../../src/explain/arch-ground";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import type { RepoGraph } from "../../src/repo-graph/types";

const idResolve = (id: string): string[] => [id.startsWith("comp:") ? id.slice(5).split("/")[0]! : id];

// hub-shaped: `core` imported heavily (in=132) imports almost nothing (out=2)
// → I=0.015, omnipresent-shaped, net=+130 (gradient says BOTTOM). `app` is the
// source (top), `util` a small sink.
const CORE_EDGES: SubdirEdge[] = [
  { source: "app", target: "core", weight: 132 },
  { source: "core", target: "util", weight: 2 },
];
const coreBands = (orders: Record<string, number>): BandLike[] => [
  { id: "APP", order: orders.APP!, members: ["app"] },
  { id: "UTIL", order: orders.UTIL!, members: ["util"] },
  { id: "CORE", order: orders.CORE!, members: ["core"] },
];

describe("groundBands — conflict-guarded topology-blind", () => {
  it("omnipresent core the LLM places HIGH (conflict) → topology-blind, NOT inferred", () => {
    // gradient expects [APP, UTIL, CORE]; LLM puts CORE at the top → conflict.
    const t = groundBands(coreBands({ CORE: 0, APP: 1, UTIL: 2 }), CORE_EDGES, idResolve);
    expect(t.get("CORE")).toBe("topology-blind");
  });

  it("omnipresent core placed at the BOTTOM (no conflict, LLM agrees) → cited (no-regress by construction)", () => {
    const t = groundBands(coreBands({ APP: 0, UTIL: 1, CORE: 2 }), CORE_EDGES, idResolve);
    expect(t.get("CORE")).toBe("cited"); // a real-sink-shaped band the LLM agrees is low is never flagged
  });

  it("a NON-omnipresent sink in conflict stays inferred (gradient trustworthy there)", () => {
    // 4-band fan: D is a sink with in-degree 3 (< θ_in=20) → NOT omnipresent.
    const FAN: SubdirEdge[] = [
      { source: "a", target: "b", weight: 1 },
      { source: "a", target: "c", weight: 1 },
      { source: "a", target: "d", weight: 1 },
      { source: "b", target: "c", weight: 1 },
      { source: "b", target: "d", weight: 1 },
      { source: "c", target: "d", weight: 1 },
    ];
    const bands: BandLike[] = [
      { id: "D", order: 0, members: ["d"] }, // sink forced to top → conflict
      { id: "A", order: 1, members: ["a"] },
      { id: "B", order: 2, members: ["b"] },
      { id: "C", order: 3, members: ["c"] },
    ];
    const t = groundBands(bands, FAN, idResolve);
    expect(t.get("D")).toBe("inferred"); // NOT topology-blind — d isn't omnipresent-shaped
  });

  it("ALL-members rule: a mixed band (omnipresent core + non-omnipresent helper) in conflict → inferred, NOT topology-blind", () => {
    // CORE band now also holds `util` (not omnipresent) → not ALL-members → inferred.
    const bands: BandLike[] = [
      { id: "CORE", order: 0, members: ["core", "util"] }, // mixed
      { id: "APP", order: 1, members: ["app"] },
    ];
    const t = groundBands(bands, CORE_EDGES, idResolve);
    expect(t.get("CORE")).not.toBe("topology-blind");
  });
});

// ── groundArchModel: the third tier must pass through the evidence fold + be
//    excluded from groundedPct (counted separately). The real makeResolveSubdir
//    closure resolves band-member NODE ids → each node's file-path members → subdir
//    ids, so the doc needs nodes whose `members` are file paths under src/<subdir>/.
const GRAPH: RepoGraph = { schemaVersion: 1, nodes: [], edges: [] };
const SRC: SourceProvider = async () => Array.from({ length: 20 }, () => "// bland").join("\n");
// Structural projection keyspace matching the test fixtures.
const SUBDIRS_KS = [{ id: "app", path: "src/app/" }, { id: "util", path: "src/util/" }, { id: "core", path: "src/core/" }];

// Bands point at node ids; each node's file-path members map to subdir core/app/util.
function coreDoc(): ArchModelDoc {
  return {
    boundary: "demo",
    bands: [
      { id: "APP", order: 1, label: { value: "App", evidence: [] }, members: ["appN"] },
      { id: "UTIL", order: 2, label: { value: "Util", evidence: [] }, members: ["utilN"] },
      { id: "CORE", order: 0, label: { value: "Core", evidence: [] }, members: ["coreN"] },
    ],
    nodes: [
      { id: "appN", kind: "cont", title: { value: "App", evidence: [] }, band: { value: "App", evidence: [] }, members: ["src/app/x.ts"] },
      { id: "utilN", kind: "cont", title: { value: "Util", evidence: [] }, band: { value: "Util", evidence: [] }, members: ["src/util/x.ts"] },
      { id: "coreN", kind: "cont", title: { value: "Core", evidence: [] }, band: { value: "Core", evidence: [] }, members: ["src/core/x.ts"] },
    ],
    edges: [],
  } as unknown as ArchModelDoc;
}

describe("groundArchModel — third tier downstream", () => {
  it("a topology-blind band label is NOT swallowed into inferred by the evidence fold", async () => {
    const res = await groundArchModel(coreDoc(), GRAPH, CORE_EDGES, SUBDIRS_KS, SRC);
    const core = res.doc.bands.find((b) => b.id === "CORE");
    expect(core?.label.tier).toBe("topology-blind");
  });

  it("topology-blind is excluded from groundedPct (numerator AND denominator) + counted separately", async () => {
    const res = await groundArchModel(coreDoc(), GRAPH, CORE_EDGES, SUBDIRS_KS, SRC);
    expect(res.topologyBlindClaims).toBe(1); // the CORE band label
    // The other two band labels are graded (inferred — empty evidence); the
    // topology-blind band is in NEITHER numerator nor denominator. (nodes add
    // their own graded title/band claims, so totalClaims > 2; the invariant we
    // assert is that the topology-blind band did not inflate the denominator.)
    const gradedBandLabels = res.doc.bands.filter((b) => b.label.tier !== "topology-blind").length;
    expect(gradedBandLabels).toBe(2);
  });
});
