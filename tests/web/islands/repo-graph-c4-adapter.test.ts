/**
 * ArchModelDoc → C4Model adapter (+ tier map).
 */
import { describe, expect, it } from "bun:test";
import { archDocToC4Model, edgeTierKey } from "../../../src/web/client/islands/repo-graph-c4-adapter";
import type { ArchModelDoc } from "../../../src/explain/arch-model-schema";

const EV = [{ file: "src/a.ts", line: 1 }];
function doc(over: Partial<ArchModelDoc> = {}): ArchModelDoc {
  return {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: EV, tier: "cited" }, order: 0, members: ["a", "b"] }],
    nodes: [
      { id: "a", kind: "cont", title: { value: "A", evidence: EV, tier: "cited" }, band: { value: "core", evidence: EV }, drillTo: "a" },
      { id: "b", kind: "cont", title: { value: "B", evidence: EV, tier: "cited" }, band: { value: "core", evidence: EV }, drillTo: "b" },
    ],
    edges: [{ source: "a", target: "b", verb: { value: "calls", evidence: EV, tier: "cited" } }],
    ...over,
  };
}

describe("archDocToC4Model", () => {
  it("maps containers → cont nodes with coords + drillTo", () => {
    const { model } = archDocToC4Model(doc(), 80);
    expect(Object.keys(model.N).sort()).toEqual(["a", "b"]);
    expect(model.N.a!.kind).toBe("cont");
    expect(model.N.a!.drillTo).toBe("a");
    expect(model.N.a!.w).toBeGreaterThan(0); // laid out
    expect(model.BOUNDARY.label).toBe("demo");
    expect(model.BANDS).toHaveLength(1);
    expect(model.__bounds.w).toBeGreaterThan(0);
  });

  it("carries edges + places ext nodes outside the boundary", () => {
    const { model } = archDocToC4Model(
      doc({
        nodes: [
          { id: "a", kind: "cont", title: { value: "A", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" },
          { id: "b", kind: "cont", title: { value: "B", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "b" },
          { id: "api", kind: "ext", title: { value: "API", evidence: EV }, band: { value: "external", evidence: EV } },
        ],
      }),
      80,
    );
    expect(model.E).toContainEqual(["a", "b", "calls"]);
    expect(model.N.api!.kind).toBe("ext");
    expect(model.N.api!.x).toBeGreaterThan(model.BOUNDARY.x + model.BOUNDARY.w); // outside, to the right
  });

  it("emits a tier map (bands by label, edges by source>target, nodes by id)", () => {
    const inferredDoc = doc({
      bands: [{ id: "core", label: { value: "Core", evidence: EV, tier: "inferred" }, order: 0, members: ["a", "b"] }],
      edges: [{ source: "a", target: "b", verb: { value: "uses", evidence: EV, tier: "inferred" } }],
    });
    const { tiers } = archDocToC4Model(inferredDoc, 50);
    expect(tiers.bands.Core).toBe("inferred");
    expect(tiers.edges[edgeTierKey("a", "b")]).toBe("inferred");
    expect(tiers.nodes.a).toBe("cited");
    expect(tiers.groundedPct).toBe(50);
  });

  it("a topology-blind band tier passes through the TierMap (not coerced to cited/inferred)", () => {
    const blindDoc = doc({
      bands: [{ id: "core", label: { value: "Core", evidence: EV, tier: "topology-blind" }, order: 0, members: ["a", "b"] }],
    });
    const { tiers } = archDocToC4Model(blindDoc, 67);
    expect(tiers.bands.Core).toBe("topology-blind"); // the renderer reads the third value, not a fallback
  });

  it("drops a band whose only members are ext nodes (no empty box)", () => {
    const { model } = archDocToC4Model(
      doc({
        bands: [
          { id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a", "b"] },
          { id: "external", label: { value: "External", evidence: EV }, order: 1, members: ["api"] },
        ],
        nodes: [
          { id: "a", kind: "cont", title: { value: "A", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" },
          { id: "b", kind: "cont", title: { value: "B", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "b" },
          { id: "api", kind: "ext", title: { value: "API", evidence: EV }, band: { value: "external", evidence: EV } },
        ],
      }),
      70,
    );
    expect(model.BANDS.map((b) => b.label)).toEqual(["Core"]); // external band dropped
    expect(model.N.api!.kind).toBe("ext"); // ext still rendered (outside)
  });

  it("treats a missing tier as inferred (never promoted to cited)", () => {
    const noTier = doc({
      bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a", "b"] }],
    });
    const { tiers } = archDocToC4Model(noTier, 0);
    expect(tiers.bands.Core).toBe("inferred");
  });
});
