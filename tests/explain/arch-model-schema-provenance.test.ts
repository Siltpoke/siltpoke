import { describe, expect, it } from "bun:test";
import { archNodeDoc, archEdgeDoc } from "../../src/explain/arch-model-schema";

describe("arch-model-schema provenance fields", () => {
  const baseClaim = (v: string) => ({ value: v, evidence: [{ file: "x.ts", line: 1 }] });

  // CRITICAL: assert the PARSED VALUE is preserved, not just success. Zod .strip()
  // silently drops unknown keys and returns success:true — so before the fields are
  // added, `.data.externalFamily` is undefined and this RED-fails correctly.
  it("node PRESERVES externalFamily + provenance (not stripped)", () => {
    const r = archNodeDoc.safeParse({
      id: "qoder-ext", kind: "ext", title: baseClaim("Qoder CLI"), band: baseClaim("external"),
      externalFamily: "qoder", provenance: "registry-declared",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.externalFamily).toBe("qoder");
    expect(r.success && r.data.provenance).toBe("registry-declared");
  });

  it("node still valid WITHOUT the new fields (optional)", () => {
    const r = archNodeDoc.safeParse({
      id: "codex-ext", kind: "ext", title: baseClaim("Codex CLI"), band: baseClaim("external"),
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown provenance value (enum, not free string)", () => {
    const r = archNodeDoc.safeParse({
      id: "x", kind: "ext", title: baseClaim("X"), band: baseClaim("external"), provenance: "made-up",
    });
    expect(r.success).toBe(false);
  });

  it("edge PRESERVES provenance (not stripped)", () => {
    const r = archEdgeDoc.safeParse({
      source: "brain", target: "qoder-ext", verb: baseClaim("spawns qodercli -p"),
      provenance: "registry-declared",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.provenance).toBe("registry-declared");
  });
});
