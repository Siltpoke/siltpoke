// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { reconcileReviewerExternals, externalScopeOf, UNRESOLVED_EXTERNAL_SCOPE, type ReconcileResult } from "../../src/explain/arch-reconcile";
import type { ReviewerExternal } from "../../src/brain/registry";

const claim = (v: string, file = "x.ts") => ({ value: v, evidence: [{ file, line: 1 }] });
const ANCHOR = 62;
const ext = (family: string, bin: string, title: string): ReviewerExternal =>
  ({ family, bin, title, evidenceFile: "src/brain/registry.ts", evidenceLine: ANCHOR, evidenceToken: "familyBinary" } as any);
const EXT: ReviewerExternal[] = [
  ext("codex", "codex", "Codex CLI"), ext("agy", "agy", "Agy CLI"),
  ext("qoder", "qodercli", "Qoder CLI"), ext("codebuddy", "codebuddy", "Codebuddy CLI"),
];
// A doc mirroring the real cache: brain container + agy/codex ext (LLM) but NO codebuddy/qoder.
const baseDoc = () => ({
  boundary: "siltpoke",
  bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
  nodes: [
    { id: "brain", kind: "cont", title: claim("Brain"), band: claim("llm"),
      members: ["src/brain/brain.ts", "src/brain/registry.ts"] },
    { id: "agy-ext", kind: "ext", title: claim("Antigravity CLI"), band: claim("external"),
      desc: claim("headless", "src/brain/providers/agy.ts") },
    { id: "codex-ext", kind: "ext", title: claim("Codex CLI"), band: claim("external") },
    { id: "ollama-ext", kind: "ext", title: claim("Ollama"), band: claim("external") },
  ],
  edges: [{ source: "brain", target: "agy-ext", verb: claim("spawns agy -p") }],
}) as any;

const run = (doc: any): ReconcileResult =>
  reconcileReviewerExternals(doc, externalScopeOf(EXT), { totalClaims: 10, citedClaims: 6 });

const extNodesForFamily = (doc: any, fam: string) =>
  doc.nodes.filter((n: any) => n.kind === "ext" && n.externalFamily === fam);

describe("reconcileReviewerExternals", () => {
  it("injects exactly the missing families (codebuddy + qoder), no others", () => {
    const { doc } = run(baseDoc());
    const injected = doc.nodes.filter((n: any) => n.provenance === "registry-declared");
    expect(injected.map((n: any) => n.externalFamily).sort()).toEqual(["codebuddy", "qoder"]);
  });
  it("does NOT add a duplicate node for an already-present family — assert absence by node COUNT", () => {
    const { doc } = run(baseDoc());
    // exactly one ext node per already-present family, and it is the LLM one (not a registry inject).
    expect(extNodesForFamily(doc, "codex").length).toBe(1);
    expect(extNodesForFamily(doc, "agy").length).toBe(1);
    expect(extNodesForFamily(doc, "codex")[0].provenance).toBe("llm-callsite");
    // and no second codex-ext / agy-ext id was appended:
    expect(doc.nodes.filter((n: any) => n.id === "codex-ext").length).toBe(1);
  });
  it("enriches matched LLM nodes with externalFamily + llm-callsite provenance", () => {
    const { doc } = run(baseDoc());
    const codex = doc.nodes.find((n: any) => n.id === "codex-ext")!;
    expect(codex.externalFamily).toBe("codex");
    expect(codex.provenance).toBe("llm-callsite");
  });
  it("leaves non-provider externals (ollama) untouched", () => {
    const { doc } = run(baseDoc());
    const ollama = doc.nodes.find((n: any) => n.id === "ollama-ext")!;
    expect(ollama.externalFamily).toBeUndefined();
    expect(ollama.provenance).toBeUndefined();
  });
  it("injected nodes are tier inferred with a valid (schema-required) evidence line", () => {
    const { doc } = run(baseDoc());
    const q = extNodesForFamily(doc, "qoder")[0];
    expect(q.title.tier).toBe("inferred");
    expect(q.title.evidence[0].file).toBe("src/brain/registry.ts");
    expect(q.title.evidence[0].line).toBe(ANCHOR); // line REQUIRED by evidenceItem schema
  });
  it("adds a brain→node edge per injection: correct source, target, verb, provenance", () => {
    const { doc } = run(baseDoc());
    const qNode = extNodesForFamily(doc, "qoder")[0];
    const qEdge = doc.edges.find((e: any) => e.target === qNode.id)!;
    expect(qEdge).toBeDefined();
    expect(qEdge.source).toBe("brain");
    expect(qEdge.verb.value).toBe("spawns qodercli -p");
    expect(qEdge.verb.tier).toBe("inferred");
    expect(qEdge.provenance).toBe("registry-declared");
    const cbNode = extNodesForFamily(doc, "codebuddy")[0];
    expect(doc.edges.some((e: any) => e.source === "brain" && e.target === cbNode.id && e.verb.value === "spawns codebuddy -p")).toBe(true);
    // every edge endpoint is a real node (integrity precondition):
    const ids = new Set(doc.nodes.map((n: any) => n.id));
    for (const e of doc.edges) { expect(ids.has(e.source)).toBe(true); expect(ids.has(e.target)).toBe(true); }
  });
  it("recounts atomically with Math.round: total += injected inferred claims, cited unchanged", () => {
    const { totalClaims, citedClaims, groundedPct } = run(baseDoc());
    expect(citedClaims).toBe(6);
    // 2 nodes × (title+band+desc = 3) + 2 edges × (verb = 1) = 8 injected inferred claims.
    expect(totalClaims).toBe(10 + 8);
    expect(groundedPct).toBe(Math.round((6 / 18) * 100)); // 33 — integer, mirrors arch-ground pct()
  });
  it("is idempotent — second pass on the reconciled doc injects nothing new", () => {
    const once = run(baseDoc());
    const twice = reconcileReviewerExternals(once.doc, externalScopeOf(EXT), { totalClaims: once.totalClaims, citedClaims: once.citedClaims });
    expect(twice.doc.nodes.length).toBe(once.doc.nodes.length);
    expect(twice.doc.edges.length).toBe(once.doc.edges.length);
    expect(twice.totalClaims).toBe(once.totalClaims); // NO count inflation on re-run
    expect(twice.groundedPct).toBe(once.groundedPct);
  });
  it("edge fail-soft: no brain container → nodes injected, NO edges added, existing edges preserved", () => {
    const doc = baseDoc();
    doc.nodes = doc.nodes.filter((n: any) => n.id !== "brain"); // remove brain container
    // keep a pre-existing non-brain edge to prove additive never strips it:
    doc.edges = [{ source: "agy-ext", target: "ollama-ext", verb: claim("mentions") }];
    const { doc: out, totalClaims } = reconcileReviewerExternals(doc, externalScopeOf(EXT), { totalClaims: 8, citedClaims: 4 });
    expect(out.nodes.filter((n: any) => n.provenance === "registry-declared").length).toBe(2);
    expect(out.edges.length).toBe(1); // only the pre-existing edge; no dangling brain edge added
    expect(out.edges[0].source).toBe("agy-ext");
    // count grows by node claims only (2×3), no edge verbs since edges skipped:
    expect(totalClaims).toBe(8 + 6);
  });
  it("pruning charges each dropped claim to the side it was ON, not always to inferred", () => {
    // Injected claims are `tier: "inferred"` today, but the type does not require
    // it. Charging a dropped CITED claim to the denominator alone leaves the
    // numerator counting a claim no longer in the document — inflating
    // groundedPct in the same direction this whole pass exists to correct.
    const doc: any = {
      boundary: "some-app",
      bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
      nodes: [
        { id: "api", kind: "cont", title: claim("API"), band: claim("core"), members: ["src/api/x.ts"] },
        {
          id: "qoder-ext", kind: "ext", externalFamily: "qoder", provenance: "registry-declared",
          title: { ...claim("Qoder CLI"), tier: "cited" },
          band: { ...claim("external"), tier: "inferred" },
          desc: { ...claim("review cli"), tier: "cited" },
        },
      ],
      edges: [],
    };
    // Empty but RESOLVED scope = the foreign-repo case → prune, no injection.
    const out = reconcileReviewerExternals(doc, externalScopeOf([]), { totalClaims: 10, citedClaims: 6 });
    expect(out.totalClaims).toBe(10 - 3); // title + band + desc
    expect(out.citedClaims).toBe(6 - 2);  // the two that were tier:"cited"
    expect(out.countsCoherent).toBe(true);
    expect(out.groundedPct).toBe(Math.round((4 / 7) * 100));
  });

  it("an UNRESOLVED scope is a no-op — no injection AND no prune", () => {
    const doc: any = {
      boundary: "siltpoke",
      bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
      nodes: [
        { id: "qoder-ext", kind: "ext", externalFamily: "qoder", provenance: "registry-declared",
          title: claim("Qoder CLI"), band: claim("external") },
      ],
      edges: [],
    };
    const out = reconcileReviewerExternals(doc, UNRESOLVED_EXTERNAL_SCOPE, { totalClaims: 10, citedClaims: 6 });
    expect(out.doc.nodes.length).toBe(1);
    expect(out.totalClaims).toBe(10);
    expect(out.citedClaims).toBe(6);
  });

  it("registry-drift: a declared family always gets a node (reconcile never probes PATH)", () => {
    const { doc } = run(baseDoc());
    expect(extNodesForFamily(doc, "qoder").length).toBe(1);
  });
  it("does NOT delete an LLM ext node absent from the registry", () => {
    const { doc } = run(baseDoc());
    expect(doc.nodes.some((n: any) => n.id === "ollama-ext")).toBe(true);
  });
});
