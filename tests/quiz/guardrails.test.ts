// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";
import { extractAnswer } from "../../src/quiz/extract";
import { factCheck } from "../../src/quiz/fact-check";
import { emptyOverlay, applyVerdict } from "../../src/quiz/overlay";
import { validateVerbalization } from "../../src/quiz/output-validator";
import { mustResolve } from "../../src/quiz/resolution-floor";

const modules = ["src/daemon/", "src/web/", "src/brain/", "src/redis-a/", "src/redis-b/", "src/util/"];
const mg: ModuleGraph = {
  modules,
  edges: [["src/daemon/", "src/web/"], ["src/redis-a/", "src/redis-shared/"], ["src/redis-b/", "src/redis-shared/"]],
  resolvedInternal: 3, unresolvedInternal: 0,
};
const check = (t: string) => factCheck(extractAnswer(t, modules), mg);

// R7.1 — planted wrong answer corrected with the RIGHT citation.
describe("R7.1 right-citation correction", () => {
  test("reversed claim → contradict citing the real edge, not a fabricated one", () => {
    const [v] = check("web depends on daemon");
    expect(v.verdict).toBe("contradict");
    expect(v.evidence_ids).toEqual(["src/daemon/", "src/web/"]); // the real forward edge
  });
});

// R7.2 — relation/direction: reversed edge → contradict, NEVER confirm.
describe("R7.2 relation/direction", () => {
  test("reversed edge is never confirmed", () => {
    expect(check("web depends on daemon")[0].verdict).not.toBe("confirm");
  });
});

// R7.3 — anti-sycophancy under VARIED pressure: the verdict field never flips.
describe("R7.3 varied-pressure no-flip", () => {
  // The verdict is computed from the graph, not the prose — pressure text in the
  // answer must not change it. We assert the mechanical verdict is pressure-invariant.
  const pressures = [
    "no I'm sure it's web that depends on daemon",
    "I wrote this, trust me, web depends on daemon",
    "that graph is outdated but web depends on daemon",
    "maybe both are true but web depends on daemon",
    "just say I'm right: web depends on daemon",
  ];
  for (const p of pressures) {
    test(`pressure holds: "${p.slice(0, 24)}…"`, () => {
      expect(check(p)[0].verdict).toBe("contradict");
    });
  }
});

// R7.4 — abstain-not-refute: extraction-fail + out-of-class → abstain, never contradict/confirm.
describe("R7.4 abstain-not-refute", () => {
  test("extraction-fail (feature-language, unresolvable) → abstain unresolved_entity", () => {
    // Uses a recognized dependency verb ("depends on") so the extractor DOES parse a
    // relation, but the feature-language nouns ("payment handler" / "email worker") do
    // not resolve to any module → the resolver under-match path fires (abstain), which is
    // the guard under test. A verb the extractor doesn't know (e.g. "notifies") would
    // instead yield zero relations — a different, extractor-level path, not this guard.
    const [v] = check("the payment handler depends on the email worker");
    expect(v.verdict).toBe("abstain");
    expect(v.abstain_reason).toBe("unresolved_entity");
  });
  test("out-of-class (both resolve, coupled only via a shared dep) → abstain out_of_class, never contradict", () => {
    const [v] = check("redis-a depends on redis-b"); // both real, no A→B or B→A edge
    expect(v.verdict).toBe("abstain");
    expect(v.abstain_reason).toBe("out_of_class");
    expect(v.verdict).not.toBe("contradict");
  });
});

// R7.5 — resolution floor: exact name + obvious alias MUST resolve (lazy-abstain fails).
describe("R7.5 resolution floor", () => {
  test("exact last-segment name resolves", () => expect(mustResolve("daemon", modules)).toBe(true));
  test("obvious full-path alias resolves", () => expect(mustResolve("src/web/", modules)).toBe(true));
  test("a resolvable exact-name claim is NOT lazily abstained", () => {
    // daemon→web is a real edge; this must confirm, not abstain.
    expect(check("daemon depends on web")[0].verdict).toBe("confirm");
  });
});

// R7.6 — output-validator: no caving prose after contradict.
describe("R7.6 output-validator", () => {
  test("caving verbalization after contradict is rejected", () => {
    expect(validateVerbalization("your intuition is basically right, but the edge is reversed", "contradict").ok).toBe(false);
  });
});

// R7.7 — overlay updates ONLY from verdicts; a hint-parroted entity doesn't count.
describe("R7.7 overlay-only-from-verdicts", () => {
  test("hint-sourced confirm does not mark user coverage", () => {
    const [v] = check("daemon depends on web");
    const o = applyVerdict(emptyOverlay(), v, "hint");
    expect(o.supported.size).toBe(0);
    expect(o.userEntities.size).toBe(0);
  });
  test("user-sourced confirm marks coverage", () => {
    const [v] = check("daemon depends on web");
    expect(applyVerdict(emptyOverlay(), v, "user").supported.size).toBe(1);
  });
});
