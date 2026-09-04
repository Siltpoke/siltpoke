// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tests for the fifth funnel stage.
 *
 * Written negative-first. A classifier that is only ever shown matching input
 * passes trivially, and the failure that matters here is the one that inflates:
 * scoring ECHO when the critique and the rule merely share vocabulary with the
 * diff. That is the confound the whole design exists to remove.
 */
import { describe, expect, test } from "bun:test";
import { classifyEcho, contentTerms, containsTerm } from "../../src/memory/rule-echo";

const RULE = { id: "lr-1", rule: "All writes under ~/.siltpoke must go through atomicWrite, never raw writeFileSync" };

describe("containsTerm — token boundaries", () => {
  test("does not match a term glued inside a longer word", () => {
    // The exact hole an independent review found in the recall grader.
    expect(containsTerm("This TypeScript diff", "type")).toBe(false);
    expect(containsTerm("looks closely guarded", "close")).toBe(false);
  });

  test("matches a standalone token, case-insensitively", () => {
    expect(containsTerm("use atomicWrite here", "atomicwrite")).toBe(true);
  });

  test("still matches tokens with punctuation at the edges", () => {
    expect(containsTerm("call foo-bar now", "foo-bar")).toBe(true);
  });
});

describe("contentTerms", () => {
  test("drops stopwords and short prose words", () => {
    const t = contentTerms("the it is a raw write");
    expect(t.has("the")).toBe(false);
    expect(t.has("raw")).toBe(false); // 3 chars, not identifier-like
    expect(t.has("write")).toBe(true);
  });

  test("keeps short code-shaped tokens", () => {
    expect(contentTerms("use fs.x and a_b").has("fs.x")).toBe(true);
    expect(contentTerms("use fs.x and a_b").has("a_b")).toBe(true);
  });
});

describe("classifyEcho", () => {
  test("ECHO — a distinctive rule term appears in the critique", () => {
    const v = classifyEcho({
      rules: [RULE],
      critique: "src/a.ts:3 writes the store without atomicWrite; a torn write corrupts it.",
      reviewedCorpus: "+ writeFileSync(path, data)",
    });
    expect(v.echoed).toEqual(["lr-1"]);
    expect(v.silent).toEqual([]);
  });

  test("SILENT — the rule had distinctive terms and none appear", () => {
    const v = classifyEcho({
      rules: [RULE],
      critique: "Looks fine. Tests cover the new path.",
      reviewedCorpus: "+ writeFileSync(path, data)",
    });
    expect(v.silent).toEqual(["lr-1"]);
    expect(v.echoed).toEqual([]);
  });

  test("🔴 the confound: shared vocabulary with the DIFF does not count as echo", () => {
    // Both the rule and the critique say writeFileSync — but so does the diff,
    // so it is not evidence the rule was used. Scoring this as ECHO is exactly
    // the inflation this design removes.
    const v = classifyEcho({
      rules: [{ id: "lr-2", rule: "never use raw writeFileSync" }],
      critique: "writeFileSync is called here without error handling.",
      reviewedCorpus: "+ writeFileSync(path, data)",
    });
    expect(v.echoed).toEqual([]);
    expect(v.indistinguishable).toEqual(["lr-2"]);
  });

  test("INDISTINGUISHABLE is not folded into SILENT", () => {
    // Undecidable must stay its own bucket — collapsing it would understate the
    // signal the same way `applied_count == 0` overstated it.
    const v = classifyEcho({
      rules: [{ id: "lr-3", rule: "prefer atomicWrite" }],
      critique: "nothing to report",
      reviewedCorpus: "atomicWrite prefer",
    });
    expect(v.indistinguishable).toEqual(["lr-3"]);
    expect(v.silent).toEqual([]);
  });

  test("detail carries the terms that decided the verdict", () => {
    const v = classifyEcho({
      rules: [RULE],
      critique: "missing atomicWrite",
      reviewedCorpus: "",
    });
    const d = v.detail.find((x) => x.id === "lr-1")!;
    expect(d.matched).toContain("atomicwrite");
    expect(d.distinctive.length).toBeGreaterThan(d.matched.length);
  });

  test("an empty rule set yields empty buckets, not a crash", () => {
    const v = classifyEcho({ rules: [], critique: "x", reviewedCorpus: "y" });
    expect(v.echoed).toEqual([]);
    expect(v.silent).toEqual([]);
    expect(v.indistinguishable).toEqual([]);
  });
});
