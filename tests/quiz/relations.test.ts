// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";
import { enumerateRelations } from "../../src/quiz/relations";

const mg: ModuleGraph = {
  modules: ["src/daemon/", "src/web/", "src/util/"],
  edges: [["src/daemon/", "src/web/"]], // daemon depends on web
  resolvedInternal: 1,
  unresolvedInternal: 0,
};

describe("enumerateRelations", () => {
  test("forward edge detected", () => {
    expect(enumerateRelations(mg, "src/daemon/", "src/web/")).toEqual({ forward: true, reverse: false });
  });
  test("reverse edge detected (direction matters)", () => {
    expect(enumerateRelations(mg, "src/web/", "src/daemon/")).toEqual({ forward: false, reverse: true });
  });
  test("no edge either way", () => {
    expect(enumerateRelations(mg, "src/util/", "src/web/")).toEqual({ forward: false, reverse: false });
  });
});
