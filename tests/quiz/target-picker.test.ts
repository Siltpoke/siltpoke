// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";
import { emptyOverlay } from "../../src/quiz/overlay";
import { pickTarget } from "../../src/quiz/target-picker";

const mg: ModuleGraph = {
  modules: ["src/daemon/", "src/web/", "src/brain/"],
  edges: [["src/daemon/", "src/web/"], ["src/daemon/", "src/brain/"]],
  resolvedInternal: 2, unresolvedInternal: 0,
};

describe("pickTarget", () => {
  test("whole-repo → first uncovered edge", () => {
    const t = pickTarget(mg, { moduleId: null }, emptyOverlay());
    expect(t).toEqual({ kind: "dependency_edge", a: "src/daemon/", b: "src/web/" });
  });
  test("skips an already-supported edge", () => {
    const o = emptyOverlay();
    o.supported.add("src/daemon/->src/web/");
    expect(pickTarget(mg, { moduleId: null }, o)).toEqual({ kind: "dependency_edge", a: "src/daemon/", b: "src/brain/" });
  });
  test("bounded scope only considers in-scope source edges", () => {
    const t = pickTarget(mg, { moduleId: "src/daemon/" }, emptyOverlay());
    expect(t).toEqual({ kind: "dependency_edge", a: "src/daemon/", b: "src/web/" });
  });
  test("all covered → exhausted", () => {
    const o = emptyOverlay();
    o.supported.add("src/daemon/->src/web/");
    o.contradicted.add("src/daemon/->src/brain/");
    expect(pickTarget(mg, { moduleId: null }, o)).toEqual({ kind: "exhausted" });
  });
  test("thin scope (module, no uncovered edges) → component_role fallback", () => {
    const thin: ModuleGraph = { modules: ["src/util/"], edges: [], resolvedInternal: 0, unresolvedInternal: 0 };
    expect(pickTarget(thin, { moduleId: "src/util/" }, emptyOverlay())).toEqual({ kind: "component_role", moduleId: "src/util/" });
  });
});
