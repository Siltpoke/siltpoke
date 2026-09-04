// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Task 4 (Slice ②): disk-level test-gap — new-vs-modified split.
 *
 * Control matrix + resolver-confirmation tests (mocked deps) per
 * .superpowers/sdd/2026-07-25-critic-disk-awareness/task-4-brief.md.
 *
 * Real-git/real-ripgrep production-path fixtures live in the companion file
 * `test-gap-disk-integration.test.ts` (split out to stay under the 400 LOC cap).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { TestGapDeps } from "../../../../src/critic/rubric/tier1/test-gap";
import { __setTestGapDeps, testGapRule } from "../../../../src/critic/rubric/tier1/test-gap";

const run = (input: Parameters<typeof testGapRule.run>[0], deps: TestGapDeps) => {
  __setTestGapDeps(deps);
  return testGapRule.run(input);
};

// MANDATORY — module-level seam leaks between tests otherwise (cross-family finding).
afterEach(() => __setTestGapDeps({}));

const bigDiff = (file: string) => ({
  cwd: "/r",
  changedFiles: [file],
  diffHunks: [{ file, addedLines: Array.from({ length: 40 }, (_, i) => i + 1) }],
});

describe("test-gap disk-level control matrix", () => {
  it("NEW file, no test on disk → FIRES (med)", async () => {
    const r = await run(bigDiff("src/new.ts"), {
      isNewFile: () => true,
      importers: () => new Map([["src/new.ts", { importers: [], truncated: false, degraded: false }]]),
    });
    expect(r.triggers.some((t) => t.severity === "med")).toBe(true);
  });

  it("NEW file, real disk test resolves → SUPPRESSED", async () => {
    const r = await run(bigDiff("src/new.ts"), {
      isNewFile: () => true,
      importers: () =>
        new Map([["src/new.ts", { importers: ["tests/new.test.ts"], truncated: false, degraded: false }]]),
    });
    expect(r.triggers).toHaveLength(0);
  });

  it("MODIFIED file, disk test exists but untouched → DOWNGRADE to low note (not med, not silent)", async () => {
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () =>
        new Map([["src/mod.ts", { importers: ["tests/mod.test.ts"], truncated: false, degraded: false }]]),
    });
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]?.severity).toBe("low"); // downgraded (RubricSeverity has no "info"), still visible
  });

  it("MODIFIED file, NO disk test → FIRES (med)", async () => {
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () => new Map([["src/mod.ts", { importers: [], truncated: false, degraded: false }]]),
    });
    expect(r.triggers.some((t) => t.severity === "med")).toBe(true);
  });

  it("degraded lookup → FAIL-OPEN: abstains (no fire, no note)", async () => {
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () => new Map([["src/mod.ts", { importers: [], truncated: false, degraded: true }]]),
    });
    expect(r.triggers).toHaveLength(0);
  });

  it("degraded importers.get() returns undefined for the key → treated as degraded (fail-open)", async () => {
    // An importers dep that doesn't populate the expected canonical key at all — the
    // `.get()` call comes back `undefined`, which must fold into the same fail-open
    // abstain path as an explicit degraded:true result.
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () => new Map(),
    });
    expect(r.triggers).toHaveLength(0);
  });

  it("throwing importers dep → fail-soft, treated as degraded (abstain, never throws)", async () => {
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () => {
        throw new Error("disk lookup exploded");
      },
    });
    expect(r.triggers).toHaveLength(0);
  });

  it("throwing isNewFile dep → fail-soft, treated as MODIFIED branch (never throws)", async () => {
    // A throw from isNewFile must not propagate and must not be misread as NEW —
    // it falls into the modified branch, so a present disk test still downgrades.
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => {
        throw new Error("git exploded");
      },
      importers: () =>
        new Map([["src/mod.ts", { importers: ["tests/mod.test.ts"], truncated: false, degraded: false }]]),
    });
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]?.severity).toBe("low");
  });
});

describe("test-gap — resolver-confirmation + classification controls", () => {
  it("MODIFIED, an UNRELATED same-basename test (different source) → does NOT suppress (fires med)", async () => {
    // importers map returns [] because resolver confirmation dropped the unrelated test —
    // a naive "any test file with this basename exists somewhere" implementation would
    // wrongly suppress here; the resolver-confirmed importers list is what test-gap trusts.
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () => new Map([["src/mod.ts", { importers: [], truncated: false, degraded: false }]]),
    });
    expect(r.triggers.some((t) => t.severity === "med")).toBe(true);
  });

  it("MODIFIED, the RELEVANT resolving test → suppresses via downgrade (low, not med)", async () => {
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () =>
        new Map([["src/mod.ts", { importers: ["tests/mod.test.ts"], truncated: false, degraded: false }]]),
    });
    expect(r.triggers.every((t) => t.severity !== "med")).toBe(true);
  });

  it("MODIFIED, hasDiskTest=true (mocked, regardless of why) → downgrades, never silently suppresses", async () => {
    // A rule-level pin, independent of the substrate: whatever makes hasDiskTest true
    // (a real test, or — before the importers.ts TYPE_ONLY_BLOCK fix — a miscounted
    // type-only import), the MODIFIED branch never silently suppresses; it downgrades to a
    // visible `low` note. The substrate-level correctness itself (does a multi-line
    // `import type` block actually get excluded) is covered by the real production-path
    // fixtures in the companion integration file, not by this mocked-deps test.
    const r = await run(bigDiff("src/mod.ts"), {
      isNewFile: () => false,
      importers: () =>
        new Map([["src/mod.ts", { importers: ["tests/mod-something.test.ts"], truncated: false, degraded: false }]]),
    });
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]?.severity).toBe("low");
  });
});
