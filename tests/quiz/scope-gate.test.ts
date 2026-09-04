// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { gateScope } from "../../src/quiz/scope-gate";
import type { IndexStaleness } from "../../src/repo-graph/index-health";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";

const mg: ModuleGraph = { modules: ["src/daemon/", "src/web/"], edges: [["src/daemon/", "src/web/"]], resolvedInternal: 1, unresolvedInternal: 0 };
// `unchanged`, `content_stale_pct`, `rows_wrong_pct` added to align with the real IndexStaleness
// shape (src/repo-graph/index-health.ts); the brief's fixtures omit all three. stalenessVerdict
// recomputes its own ratio from the raw counts (never reads these derived fields), so they don't
// affect the gate verdicts below — they just make the fixtures type-check, filled with the values
// computeStaleness would itself produce for these counts.
const fresh: IndexStaleness = { indexed: 10, unchanged: 10, content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, read_errors: 0, content_stale_pct: 0, rows_wrong_pct: 0 };

describe("gateScope", () => {
  test("fresh + clean + scope exists → ok", () => {
    expect(gateScope({ staleness: fresh, warnPct: 0.2, mg, scope: { moduleId: "src/daemon/" }, dirty: false })).toEqual({ ok: true });
  });
  test("selected scope no longer in graph → scope_gone", () => {
    const r = gateScope({ staleness: fresh, warnPct: 0.2, mg, scope: { moduleId: "src/gone/" }, dirty: false });
    expect(r).toMatchObject({ ok: false, reason: "scope_gone" });
  });
  test("stale index → stale (blocks even a valid scope)", () => {
    const stale: IndexStaleness = { indexed: 10, unchanged: 5, content_changed: 5, deleted_still_indexed: 0, unindexed_files: 0, read_errors: 0, content_stale_pct: 0.5, rows_wrong_pct: 0.5 };
    expect(gateScope({ staleness: stale, warnPct: 0.2, mg, scope: { moduleId: "src/daemon/" }, dirty: false })).toMatchObject({ ok: false, reason: "stale" });
  });
  test("dirty working tree → dirty", () => {
    expect(gateScope({ staleness: fresh, warnPct: 0.2, mg, scope: { moduleId: null }, dirty: true })).toMatchObject({ ok: false, reason: "dirty" });
  });
});
