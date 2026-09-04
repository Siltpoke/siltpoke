// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";
import { extractAnswer, factCheck, emptyOverlay, applyVerdict, pickTarget, buildWrapup } from "../../src/quiz";

const modules = ["src/daemon/", "src/web/"];
const mg: ModuleGraph = { modules, edges: [["src/daemon/", "src/web/"]], resolvedInternal: 1, unresolvedInternal: 0 };

describe("engine smoke — one full turn", () => {
  test("pick → answer → verdict → overlay → wrap-up", () => {
    const target = pickTarget(mg, { moduleId: null }, emptyOverlay());
    expect(target.kind).toBe("dependency_edge");
    const [v] = factCheck(extractAnswer("daemon depends on web", modules), mg);
    const overlay = applyVerdict(emptyOverlay(), v, "user");
    expect(overlay.supported.size).toBe(1);
    expect(buildWrapup(overlay)).toContain("src/daemon/");
  });
});
