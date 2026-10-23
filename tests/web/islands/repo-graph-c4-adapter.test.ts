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

describe("the outside column sits level with the bands (found in a hands-on test)", () => {
  const ext = (id: string) => ({ id, kind: "ext" as const, title: { value: id, evidence: EV }, band: { value: "external", evidence: EV } });
  const cont = (id: string, band: string) => ({ id, kind: "cont" as const, title: { value: id, evidence: EV }, band: { value: band, evidence: EV }, drillTo: id });
  /** Three bands of two rows each: a column of `n` outside boxes has room to spread. */
  function tall(n: number) {
    const ids = (b: string) => Array.from({ length: 10 }, (_, i) => `${b}${i}`);
    const bands = ["p", "q", "r"].map((b, order) => ({ id: b, label: { value: b, evidence: EV }, order, members: ids(b) }));
    const nodes = [...["p", "q", "r"].flatMap((b) => ids(b).map((id) => cont(id, b))), ...Array.from({ length: n }, (_, i) => ext(`x${i}`))];
    return archDocToC4Model(doc({ bands, nodes, edges: [] }), 80).model;
  }
  const outside = (m: ReturnType<typeof tall>) => Object.values(m.N).filter((n) => n.kind !== "cont").sort((a, b) => a.y - b.y);
  it("spreads evenly from the first band's top to the last band's bottom, sizes unchanged", () => {
    const m = tall(4);
    const xs = outside(m);
    const first = m.BANDS[0];
    const last = m.BANDS[m.BANDS.length - 1];
    expect(xs[0].y).toBeCloseTo(first.y, 6);
    expect(xs[3].y + xs[3].h).toBeCloseTo(last.y + last.h, 6);
    const gaps = xs.slice(1).map((n, i) => n.y - (xs[i].y + xs[i].h));
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
    expect(gaps[0]).toBeGreaterThan(16); // more than the old fixed gap: it really spread
    for (const n of xs) expect([n.w, n.h]).toEqual([200, 92]);
    expect(new Set(xs.map((n) => n.x)).size).toBe(1);
  });
  it("a single outside box is centred on the bands' span", () => {
    const m = tall(1);
    const [x] = outside(m);
    const top = m.BANDS[0].y;
    const bottom = m.BANDS[m.BANDS.length - 1].y + m.BANDS[m.BANDS.length - 1].h;
    expect(x.y + x.h / 2).toBeCloseTo((top + bottom) / 2, 6);
  });
  it("a column taller than the bands stacks from the first band's top with the plain 16px gap, and the scene grows to hold it", () => {
    const m = archDocToC4Model(doc({ nodes: [...doc().nodes, ...Array.from({ length: 6 }, (_, i) => ext(`x${i}`))] }), 80).model;
    const xs = outside(m);
    expect(xs[0].y).toBe(m.BANDS[0].y);
    for (const [i, n] of xs.slice(1).entries()) expect(n.y - (xs[i].y + xs[i].h)).toBe(16);
    expect(m.__bounds.h).toBeGreaterThanOrEqual(xs[5].y + xs[5].h);
  });
});
