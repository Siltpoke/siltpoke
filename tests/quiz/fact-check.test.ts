// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { extractAnswer } from "../../src/quiz/extract";
import { factCheck } from "../../src/quiz/fact-check";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";

const modules = ["src/daemon/", "src/web/", "src/brain/", "src/util/"];
const mg: ModuleGraph = {
  modules,
  edges: [["src/daemon/", "src/web/"]], // daemon → web only
  resolvedInternal: 1,
  unresolvedInternal: 0,
};
const check = (text: string) => factCheck(extractAnswer(text, modules), mg);

describe("factCheck", () => {
  test("true forward claim → confirm", () => {
    const [v] = check("daemon depends on web");
    expect(v.verdict).toBe("confirm");
    expect(v.claim).toEqual({ entityA: "src/daemon/", entityB: "src/web/", relType: "depends_on" });
  });
  test("reversed claim → contradict (never confirm), with positive evidence", () => {
    const [v] = check("web depends on daemon");
    expect(v.verdict).toBe("contradict");
    expect(v.evidence_ids).toEqual(["src/daemon/", "src/web/"]);
  });
  test("no-edge-either-way → abstain out_of_class (NEVER contradict on absence)", () => {
    const [v] = check("util depends on web");
    expect(v.verdict).toBe("abstain");
    expect(v.abstain_reason).toBe("out_of_class");
  });
  test("unresolved entity → abstain unresolved_entity, null claim", () => {
    const [v] = check("payments depends on web");
    expect(v.verdict).toBe("abstain");
    expect(v.abstain_reason).toBe("unresolved_entity");
    expect(v.claim).toBeNull();
  });
  test("multi-part answer → one verdict object per relation", () => {
    const out = check("daemon depends on web and web depends on daemon");
    expect(out.map((v) => v.verdict)).toEqual(["confirm", "contradict"]);
  });
});
