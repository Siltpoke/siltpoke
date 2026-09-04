import { describe, expect, it } from "bun:test";
import { finalizeArchModel } from "../../src/explain/arch-generate";
import { anchoredRepoRoot, foreignRepoRoot } from "../_shared/arch-repo-root";

const claim = (v: string, file = "x.ts") => ({ value: v, evidence: [{ file, line: 1 }], tier: "inferred" as const });
// A GroundResult-shaped input: brain container + agy/codex ext, NO codebuddy/qoder.
const grounded: any = {
  doc: {
    boundary: "siltpoke",
    bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
    nodes: [
      { id: "brain", kind: "cont", title: claim("Brain"), band: claim("llm"), members: ["src/brain/brain.ts"] },
      { id: "agy-ext", kind: "ext", title: claim("Antigravity CLI"), band: claim("external"),
        desc: claim("hl", "src/brain/providers/agy.ts") },
      { id: "codex-ext", kind: "ext", title: claim("Codex CLI"), band: claim("external") },
    ],
    edges: [],
  },
  groundedPct: 50, citedClaims: 5, totalClaims: 10, topologyBlindClaims: 0,
};

describe("finalizeArchModel (generate-path self-canary)", () => {
  it("reconciles reviewer externals — codebuddy + qoder land in the finalized doc", () => {
    // If the reconcile call is removed from finalizeArchModel, these two never appear → RED.
    const out = finalizeArchModel(grounded, new Set<string>(), [], anchoredRepoRoot());
    const injected = out.doc.nodes.filter((n: any) => n.provenance === "registry-declared").map((n: any) => n.externalFamily).sort();
    expect(injected).toEqual(["codebuddy", "qoder"]);
  });
  it("threads reconcile-adjusted counts, not the raw grounding counts", () => {
    const out = finalizeArchModel(grounded, new Set<string>(), [], anchoredRepoRoot());
    expect(out.totalClaims).toBeGreaterThan(10); // grew by the injected inferred claims
    expect(out.citedClaims).toBe(5);             // cited unchanged
    expect(out.groundedPct).toBe(Math.round((5 / out.totalClaims) * 100));
    expect(out.topologyBlindClaims).toBe(0);     // passed through untouched
  });
  it("generating for a repo WITHOUT the registry anchor injects nothing", () => {
    // The generate path is where the pollution was WRITTEN to disk; scoping the
    // read alone would keep re-creating it on every re-generate.
    const out = finalizeArchModel(grounded, new Set<string>(), [], foreignRepoRoot());
    expect(out.doc.nodes.filter((n: any) => n.provenance === "registry-declared")).toEqual([]);
    expect(out.totalClaims).toBe(10); // denominator untouched — nothing was claimed
  });
});
