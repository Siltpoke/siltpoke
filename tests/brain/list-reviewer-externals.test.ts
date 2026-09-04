import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listReviewerExternals, FAMILY_BINARY_ANCHOR_LINE } from "../../src/brain/registry";
import { FAMILIES } from "../../src/brain/brain-config";
import { familyBinary } from "../../src/brain/registry";

describe("listReviewerExternals", () => {
  it("maps 1:1 to the non-null-binary FAMILIES — derived, not hardcoded (auto-updates)", () => {
    // Expected set is DERIVED from the registry, so a 5th provider auto-includes.
    const expected = FAMILIES.filter((f) => familyBinary(f) !== null).sort();
    const got = listReviewerExternals().map((e) => e.family).sort();
    expect(got).toEqual(expected);
    // claude has bin=null, so it must be the one excluded (guards the filter, non-vacuously).
    expect(familyBinary("claude")).toBeNull();
    expect(got).not.toContain("claude");
  });

  it("derives bin + title mechanically (no per-family prose)", () => {
    const byFamily = Object.fromEntries(listReviewerExternals().map((e) => [e.family, e]));
    expect(byFamily.qoder!.bin).toBe("qodercli");
    expect(byFamily.qoder!.title).toBe("Qoder CLI");
    expect(byFamily.codebuddy!.bin).toBe("codebuddy");
    expect(byFamily.codebuddy!.title).toBe("Codebuddy CLI");
    expect(byFamily.codex!.title).toBe("Codex CLI");
  });

  it("evidence points at registry.ts with a valid line", () => {
    for (const e of listReviewerExternals()) {
      expect(e.evidenceFile).toBe("src/brain/registry.ts");
      expect(e.evidenceLine).toBe(FAMILY_BINARY_ANCHOR_LINE);
      expect(Number.isInteger(e.evidenceLine)).toBe(true);
      expect(e.evidenceLine).toBeGreaterThan(0);
    }
  });

  it("ANCHOR drift guard: the anchor line actually contains familyBinary (audit-A re-check)", () => {
    // If registry.ts is edited and the anchor drifts, this RED-fails — the mechanized
    // re-check that keeps the injected evidence honest (audit item A invariant).
    const src = readFileSync(join(process.cwd(), "src/brain/registry.ts"), "utf8").split("\n");
    expect(src[FAMILY_BINARY_ANCHOR_LINE - 1]).toContain("familyBinary");
  });
});
