/**
 * Unit — computeStaleness pure derivation.
 *
 * Asserts all four branches without shelling: the git probe is stubbed.
 * The load-bearing case: non-ancestor and null bootSha must yield
 * commitsBehind:null + state:"unknown", NEVER a misleading number.
 */
import { describe, expect, test } from "bun:test";
import {
  computeStaleness,
  findSourceRepoRoot,
  type GitProbe,
  stalenessBannerSignal,
} from "../../src/daemon/build-state";

/** Stub probe — every method overridable; defaults throw to catch accidental use. */
function stubProbe(over: Partial<GitProbe> = {}): GitProbe {
  return {
    headSha: () => {
      throw new Error("headSha not stubbed");
    },
    isAncestor: () => {
      throw new Error("isAncestor not stubbed");
    },
    countBetween: () => {
      throw new Error("countBetween not stubbed");
    },
    ...over,
  };
}

describe("computeStaleness", () => {
  test("current — bootSha === headSha → commitsBehind 0", () => {
    const r = computeStaleness("abc", "abc", stubProbe());
    expect(r).toEqual({ headSha: "abc", commitsBehind: 0, state: "current" });
  });

  test("behind — ancestor with N between → commitsBehind N (the real number)", () => {
    const probe = stubProbe({
      isAncestor: (a, d) => a === "boot" && d === "head",
      countBetween: () => 3,
    });
    const r = computeStaleness("boot", "head", probe);
    expect(r).toEqual({ headSha: "head", commitsBehind: 3, state: "behind" });
    // non-vacuous: the actual N is surfaced, not a placeholder.
    expect(r.commitsBehind).toBe(3);
  });

  test("unknown — bootSha not an ancestor (force-push/rebase) → null, never a number", () => {
    const probe = stubProbe({
      isAncestor: () => false,
      // countBetween must NOT be consulted once non-ancestor — default throws.
    });
    const r = computeStaleness("boot", "head", probe);
    expect(r).toEqual({ headSha: "head", commitsBehind: null, state: "unknown" });
    expect(r.commitsBehind).toBeNull();
  });

  test("unknown — bootSha null (non-git / boot capture failed) → null", () => {
    const r = computeStaleness(null, "head", stubProbe());
    expect(r).toEqual({ headSha: "head", commitsBehind: null, state: "unknown" });
  });

  test("unknown — probe error during ancestry check → null, never a number", () => {
    const probe = stubProbe({ isAncestor: () => null });
    const r = computeStaleness("boot", "head", probe);
    expect(r.commitsBehind).toBeNull();
    expect(r.state).toBe("unknown");
  });

  test("unknown — headSha null (request-time git error) → null", () => {
    const r = computeStaleness("boot", null, stubProbe());
    expect(r).toEqual({ headSha: null, commitsBehind: null, state: "unknown" });
  });
});

describe("stalenessBannerSignal (dashboard strip predicate)", () => {
  test("behind — shows the strip with the real N", () => {
    const s = stalenessBannerSignal("behind", 7);
    expect(s.show).toBe(true);
    // non-vacuous: the actual N is interpolated, not a placeholder.
    expect(s.line).toBe("⚠ daemon 7 commits behind — restart to pick up changes");
    expect(s.line).toContain("7");
  });

  test("current — no strip (no false nag on an up-to-date daemon)", () => {
    const s = stalenessBannerSignal("current", 0);
    expect(s).toEqual({ show: false, line: "" });
  });

  test("unknown — no strip (doctor carries the 'unknown' detail, not the dashboard)", () => {
    const s = stalenessBannerSignal("unknown", null);
    expect(s).toEqual({ show: false, line: "" });
  });

  test("defensive — 'behind' with null/non-positive N never renders a bogus number", () => {
    expect(stalenessBannerSignal("behind", null)).toEqual({ show: false, line: "" });
    expect(stalenessBannerSignal("behind", 0)).toEqual({ show: false, line: "" });
  });
});

describe("findSourceRepoRoot", () => {
  test("finds the siltpoke repo root walking up from this test's dir", () => {
    // This test file lives inside the siltpoke git checkout → a root must resolve.
    const root = findSourceRepoRoot(import.meta.dir);
    expect(root).not.toBeNull();
  });
});
