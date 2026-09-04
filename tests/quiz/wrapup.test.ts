// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { emptyOverlay } from "../../src/quiz/overlay";
import { buildWrapup } from "../../src/quiz/wrapup";

describe("buildWrapup", () => {
  const o = emptyOverlay();
  o.supported.add("src/daemon/->src/web/");
  o.unverified.add("src/critic/->src/brain/");

  test("names established edges in graph terms", () => {
    const w = buildWrapup(o);
    expect(w).toContain("src/daemon/");
    expect(w).toContain("src/web/");
  });
  test("names what was not established", () => {
    expect(buildWrapup(o)).toContain("src/critic/");
  });
  test("no score/tally/percent — no digit and no % anywhere", () => {
    const w = buildWrapup(o);
    expect(/[0-9]/.test(w)).toBe(false);
    expect(w.includes("%")).toBe(false);
  });
  test("no evaluative adjectives", () => {
    const w = buildWrapup(o).toLowerCase();
    for (const adj of ["solid", "strong", "needs work", "well done", "great", "good job", "good"]) {
      expect(w.includes(adj)).toBe(false);
    }
  });
});

describe("buildWrapup — contradicted edge direction", () => {
  // User wrongly said "web depends on daemon"; the real edge is daemon → web.
  // Stored contradicted key is the user's reversed claim: "src/web/->src/daemon/".
  const o = emptyOverlay();
  o.contradicted.add("src/web/->src/daemon/");

  test("names the REAL direction (daemon → web)", () => {
    const w = buildWrapup(o);
    expect(w).toContain("src/daemon/ → src/web/");
  });
  test("does NOT present the wrong direction as a place to look next", () => {
    const w = buildWrapup(o);
    expect(w).not.toContain("src/web/ → src/daemon/");
    expect(w).not.toContain("a place to look next");
  });
  test("no digit / no evaluative adjective with a contradicted edge present", () => {
    const w = buildWrapup(o);
    expect(/[0-9]/.test(w)).toBe(false);
    expect(w.includes("%")).toBe(false);
    const lower = w.toLowerCase();
    for (const adj of ["solid", "strong", "needs work", "well done", "great", "good job", "good"]) {
      expect(lower.includes(adj)).toBe(false);
    }
  });
});
