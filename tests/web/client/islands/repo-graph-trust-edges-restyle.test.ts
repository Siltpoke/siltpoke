import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./_dom-harness";
import type { TrustMap } from "../../../../src/repo-graph/trust-map";

beforeAll(() => registerDom());
afterAll(async () => {
  await unregisterDom();
});

function mapWith(solid: boolean): TrustMap {
  return {
    schema: 1,
    source: "generated",
    stamp: { mapDate: "2026-09-29T00:00:00.000Z", commit: null, commitsAhead: null, headRelation: "same" },
    containers: [],
    edges: [{ source: "a", target: "b", verb: "feeds", solid, evidence: { kind: "none", reason: "no-import-no-citation" } }],
    totals: null,
    notShown: [],
  } as TrustMap;
}

describe("restyleGeneratedEdges", () => {
  test("toggles the dasharray AND the label's inferred class, both directions", async () => {
    const { restyleGeneratedEdges } = await import("../../../../src/web/client/islands/repo-graph-trust-edges");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const lab = document.createElement("div");
    lab.className = "c4-elab";
    const edges = [{ s: "a", t: "b", path, lab }];
    const legacy = () => false;

    restyleGeneratedEdges(edges, legacy, { status: "ready", map: mapWith(false) }); // -> dashed
    expect(path.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(lab.classList.contains("inferred")).toBe(true);

    restyleGeneratedEdges(edges, legacy, { status: "ready", map: mapWith(true) }); // -> solid
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
    expect(lab.classList.contains("inferred")).toBe(false);

    restyleGeneratedEdges(edges, () => true, { status: "failed" }); // legacy inferred -> dashed again
    expect(path.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(lab.classList.contains("inferred")).toBe(true);
  });
});
