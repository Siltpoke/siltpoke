// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { CONDUCTOR_SYSTEM_PROMPT, buildConductorTurn } from "../../src/quiz/conductor-prompt";

describe("conductor prompt", () => {
  test("system prompt carries the non-negotiable discipline clauses", () => {
    const p = CONDUCTOR_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("never decide");        // LLM never decides a verdict
    expect(p).toContain("no score");             // no score/tally
    expect(p).toContain("ask");                  // ask-don't-tell
    expect(p).toContain("do not praise");        // clear-without-shaming
  });
  test("a turn embeds the pre-decided verdict for the Brain to verbalize (not decide)", () => {
    const turn = buildConductorTurn({
      scope: { moduleId: "src/daemon/" },
      target: { kind: "dependency_edge", a: "src/daemon/", b: "src/web/" },
      priorVerdict: { kind: "structural_verdict", claim: { entityA: "src/web/", entityB: "src/daemon/", relType: "depends_on" }, verdict: "contradict", evidence_ids: ["src/daemon/", "src/web/"], confidence: 1 },
    });
    expect(turn).toContain("contradict");
    expect(turn).toContain("src/daemon/");
  });
  test("a contradict turn threads evidence_ids (real-direction ids) for R7.1 right-citation", () => {
    const turn = buildConductorTurn({
      scope: { moduleId: "src/daemon/" },
      target: { kind: "dependency_edge", a: "src/daemon/", b: "src/web/" },
      priorVerdict: { kind: "structural_verdict", claim: { entityA: "src/web/", entityB: "src/daemon/", relType: "depends_on" }, verdict: "contradict", evidence_ids: ["src/daemon/", "src/web/"], confidence: 1 },
    });
    expect(turn).toContain("evidence=src/daemon/,src/web/");
    expect(turn).toContain("src/daemon/");
    expect(turn).toContain("src/web/");
  });
  test("no target ⇒ turn asks about the component role, still no verdict authoring", () => {
    const turn = buildConductorTurn({ scope: { moduleId: "src/util/" }, target: { kind: "component_role", moduleId: "src/util/" } });
    expect(turn).toContain("src/util/");
  });
});
