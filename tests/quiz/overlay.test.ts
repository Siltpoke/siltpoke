// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { emptyOverlay, applyVerdict } from "../../src/quiz/overlay";
import type { StructuralVerdictObject } from "../../src/quiz/types";

const confirm: StructuralVerdictObject = {
  kind: "structural_verdict",
  claim: { entityA: "src/daemon/", entityB: "src/web/", relType: "depends_on" },
  verdict: "confirm", evidence_ids: ["src/daemon/", "src/web/"], confidence: 1,
};

describe("applyVerdict", () => {
  test("user confirm → supported + userEntities", () => {
    const o = applyVerdict(emptyOverlay(), confirm, "user");
    expect([...o.supported]).toEqual(["src/daemon/->src/web/"]);
    expect(o.userEntities.has("src/daemon/")).toBe(true);
    expect(o.userEntities.has("src/web/")).toBe(true);
  });
  test("hint source never marks user coverage", () => {
    const o = applyVerdict(emptyOverlay(), confirm, "hint");
    expect(o.supported.size).toBe(0);
    expect(o.userEntities.size).toBe(0);
    expect(o.hintEntities.has("src/daemon/")).toBe(true);
  });
  test("abstain with a claim → unverified, not supported", () => {
    const abstain: StructuralVerdictObject = { ...confirm, verdict: "abstain", abstain_reason: "out_of_class" };
    const o = applyVerdict(emptyOverlay(), abstain, "user");
    expect(o.supported.size).toBe(0);
    expect([...o.unverified]).toEqual(["src/daemon/->src/web/"]);
  });
  test("null-claim verdict touches nothing", () => {
    const nullClaim: StructuralVerdictObject = { kind: "structural_verdict", claim: null, verdict: "abstain", evidence_ids: [], confidence: 0, abstain_reason: "unresolved_entity" };
    const o = applyVerdict(emptyOverlay(), nullClaim, "user");
    expect(o.supported.size + o.contradicted.size + o.unverified.size + o.userEntities.size).toBe(0);
  });
  test("overlay carries no numeric coverage field", () => {
    const o = applyVerdict(emptyOverlay(), confirm, "user");
    expect(Object.values(o).every((v) => v instanceof Set)).toBe(true);
  });
});
