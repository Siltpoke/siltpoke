// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import type { BrainOutput } from "../../../src/brain/schema";
import { buildReverseDepsSection, canonicalPath } from "../../../src/critic/disk-awareness/reverse-deps";
import { guardCritique } from "../../../src/critic/evidence-guard";
import { fakeDeps } from "./fixtures";

describe("buildReverseDepsSection", () => {
  it("lists a confirmed importer and emits its BARE path as a token", () => {
    const files = { "src/a/foo.ts": "export const x=1;", "src/consumer.ts": "import {x} from './a/foo';" };
    const r = buildReverseDepsSection({ changedFiles: ["src/a/foo.ts"], cwd: "/r" }, fakeDeps(files));
    expect(r.section).toContain("src/a/foo.ts");
    expect(r.section).toContain("src/consumer.ts");
    expect(r.tokens).toContain("src/consumer.ts"); // BARE path, not "dep: src/consumer.ts"
    expect(r.tokens.some((t) => t.startsWith("dep:"))).toBe(false);
  });

  it("omits a same-basename non-importer (resolver confirmation)", () => {
    const files = {
      "src/a/foo.ts": "export const x=1;",
      "src/b/foo.ts": "export const y=2;",
      "src/d.ts": "import {y} from './b/foo';",
    };
    const r = buildReverseDepsSection({ changedFiles: ["src/a/foo.ts"], cwd: "/r" }, fakeDeps(files));
    expect(r.section).toBe("");
  });

  it("empty section when zero importers", () => {
    const files = { "src/lonely.ts": "export const z=1;" };
    const r = buildReverseDepsSection({ changedFiles: ["src/lonely.ts"], cwd: "/r" }, fakeDeps(files));
    expect(r).toEqual({ section: "", tokens: [] });
  });

  it("returns empty on failure without throwing (fail-soft)", () => {
    const throwing = {
      ripgrep: () => {
        throw new Error("rg missing");
      },
      listFiles: () => [],
    };
    expect(() =>
      buildReverseDepsSection({ changedFiles: ["src/a.ts"], cwd: "/r" }, throwing),
    ).not.toThrow();
    const r = buildReverseDepsSection({ changedFiles: ["src/a.ts"], cwd: "/r" }, throwing);
    expect(r).toEqual({ section: "", tokens: [] });
  });

  // [mutation-target] The test above only proves `importersOf`'s OWN internal `safe()`
  // resilience (a thrown `deps.ripgrep` never escapes importersOf — it degrades and
  // returns an empty-importers map instead of throwing), so `buildReverseDepsSection`'s
  // outer try/catch never actually fires there. This test forces a throw INSIDE this
  // module's own try block — `args.changedFiles.filter(isSource)` on a non-array — so
  // the outer catch itself is the thing under test, matching the docstring's claim
  // ("any failure ... or any unexpected shape" collapses to the fail-soft result).
  it("[mutation-target] survives a malformed changedFiles input via THIS module's own outer catch", () => {
    const malformed = { changedFiles: null as unknown as string[], cwd: "/r" };
    expect(() => buildReverseDepsSection(malformed)).not.toThrow();
    expect(buildReverseDepsSection(malformed)).toEqual({ section: "", tokens: [] });
  });
});

describe("canonicalPath", () => {
  it("strips a leading ./ and normalizes backslashes to forward slashes", () => {
    expect(canonicalPath("./src/a/foo.ts")).toBe("src/a/foo.ts");
    expect(canonicalPath("src\\a\\foo.ts")).toBe("src/a/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// Evidence-guard integration [production-path] — cross-family finding.
//
// evidence-guard.ts's `guardCritique` is a SUBSTRING-of-corpus check
// (`citationCorpus.includes(item.file)` / `.includes(item.snippet)`), so a
// "dep:"-prefixed token would ALSO have passed (the bare path is still a
// substring). The distinguishing mutation is therefore NOT a "dep:" prefix
// swap — it's deleting `tokens.push(...)` entirely. This test calls the REAL
// guard (not a `tokens.includes` unit assertion) and builds its corpus ONLY
// from `tokens` (never from `section`), so it stays sensitive to that exact
// mutation: if `section` were mixed into the corpus, `section` itself already
// contains "src/consumer.ts" prose and the test would falsely stay green.
// ---------------------------------------------------------------------------

const baseBrainOutput: BrainOutput = {
  mood: "annoyed",
  pose: "arms_crossed",
  bubble_short: "something looks off",
  bubble_long: "details here",
  critique_for_claude: "fix this",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
  evidence: [],
};

describe("buildReverseDepsSection — evidence-guard integration [production-path]", () => {
  it("a model citation of an importer OUTSIDE changedFiles survives the REAL guard only via the bare-path token corpus", () => {
    const files = { "src/a/foo.ts": "export const x=1;", "src/consumer.ts": "import {x} from './a/foo';" };
    const { tokens } = buildReverseDepsSection({ changedFiles: ["src/a/foo.ts"], cwd: "/r" }, fakeDeps(files));
    expect(tokens).toContain("src/consumer.ts");

    // Caller-token-only corpus (mirrors evidence-guard's "+ caller tokens" corpus component) —
    // deliberately WITHOUT `section` prose so the Step-5 mutation can't hide behind it.
    const citationCorpus = tokens.join("\n");
    const changedFiles = new Set(["src/a/foo.ts"]);

    // Model prose citing the importer's bare path — src/consumer.ts is NOT in changedFiles,
    // it is only reachable in the token corpus.
    const out: BrainOutput = {
      ...baseBrainOutput,
      critique_for_claude: "Changing src/a/foo.ts affects its importer src/consumer.ts.",
      evidence: [{ tool: "ripgrep", file: "src/consumer.ts", snippet: "src/consumer.ts" }],
    };

    const result = guardCritique(out, "NORMAL", citationCorpus, changedFiles);
    // Asserting on `verified` rather than a label: the point of this test is
    // that THIS item survives the corpus check, and a label alone could read
    // "verified" off an evidence array the mutation had emptied.
    expect(result.verified).toEqual(out.evidence);
    expect(result.unverified).toEqual([]);
  });
});
