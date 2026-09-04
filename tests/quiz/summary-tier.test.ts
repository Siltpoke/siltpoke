// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";
import { structuralSummary } from "../../src/quiz/summary-tier";

const mg: ModuleGraph = {
  modules: ["src/daemon/", "src/web/", "src/brain/"],
  edges: [["src/daemon/", "src/web/"], ["src/brain/", "src/web/"]],
  resolvedInternal: 2, unresolvedInternal: 0,
};

describe("structuralSummary", () => {
  test("reports depends-on and depended-by from wiring", () => {
    const s = structuralSummary(mg, "src/web/");
    expect(s.importsInto).toEqual([]);
    expect(s.usedBy.sort()).toEqual(["src/brain/", "src/daemon/"]);
  });
  test("always low-confidence, no verdict, wiring-not-intent note", () => {
    const s = structuralSummary(mg, "src/daemon/");
    expect(s.confidence).toBe("low");
    expect(s.verdict).toBeNull();
    expect(s.note).toBe("from the wiring, not from intent");
    expect(s.importsInto).toEqual(["src/web/"]);
  });
});
