// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { archDocToC4Model } from "../../src/web/client/islands/repo-graph-c4-adapter";

const claim = (v: string) => ({ value: v, evidence: [{ file: "src/brain/registry.ts" }], tier: "inferred" as const });

describe("c4 adapter carries provenance", () => {
  it("maps registry-declared provenance onto the C4 ext node", () => {
    const doc: any = {
      boundary: "r",
      bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
      nodes: [{ id: "qoder-ext", kind: "ext", title: claim("Qoder CLI"), band: claim("external"),
        desc: claim("External review CLI (registry-declared; reachability unverified)"),
        externalFamily: "qoder", provenance: "registry-declared" }],
      edges: [],
    };
    const { model } = archDocToC4Model(doc, 90);
    const node = model.N["qoder-ext"];
    expect(node).toBeDefined();
    expect(node!.provenance).toBe("registry-declared");   // typed field, not `as any`
    expect(node!.externalFamily).toBe("qoder");
  });
});
