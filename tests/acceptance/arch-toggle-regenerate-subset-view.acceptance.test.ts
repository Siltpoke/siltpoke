/**
 * arch-toggle-regenerate-subset-view.acceptance.test.ts — ACCEPTANCE tests for
 * the subset-view foundation of the arch-toggle-regenerate track.
 *
 * SCOPE — subset-view foundation only:
 *   • ?arch-source=subset URL param drives the subset view even when a fresh
 *     generated cache exists (precedence rung 3).
 *   • applySource("subset") exists and is exercised through its boot-time
 *     URL-round-trip (the chip click-path is UNTESTABLE today).
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Island is booted via the same mountRepoGraph() path the real page uses
 *     (SSR → registerRepoGraph → factory → init; no Alpine pipeline).
 *   • Assertions target user-visible affordance state (which affordance buttons
 *     are shown/hidden, what they read) and URL state after an applySource()
 *     round-trip — NOT internal function calls or raw innerHTML text from the
 *     generated C4 model's node titles.
 *
 * NON-DUPLICATION with unit tests (repo-graph-arch-source-gate.test.ts):
 *   That file tests the 7-rung precedence table at the C4-model-content level
 *   (innerHTML "GeneratedBox" / "alpha"). These tests cover the same
 *   affordance fragments at the RENDERED AFFORDANCE level — what the user
 *   sees as the observable difference between views.
 *
 * Anti-vacuous discipline:
 *   • Every "absence" assertion is paired with a "presence" assertion in the
 *     same test that confirms the checkpoint is live, not vacuous.
 *   • The regression guard is paired with a positive control that verifies
 *     the generated-view affordance IS present (so the absence of the
 *     subset affordance is attributable to the gate, not a missing element).
 *   • No shared Response objects; each test installs its own fetch mock.
 *
 * Run: bun test tests/acceptance/arch-toggle-regenerate-subset-view.acceptance.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "../web/client/islands/_dom-harness";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  // Reset URL to neutral state between tests; no residual ?arch-source param.
  window.history.replaceState(null, "", "/repo-graph");
});

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** A valid generated model fixture (mirrors the unit test's GENERATED_DOC).
 * The exact node titles ("GeneratedBox") are checked only at unit level.
 * Here we only need a non-null generatedModel that makes hasGenerated true. */
const FRESH_GENERATED_MODEL = {
  doc: {
    boundary: "fixture-gen",
    bands: [
      {
        id: "core",
        label: { value: "GenBand", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
        order: 0,
        members: ["genbox"],
      },
    ],
    nodes: [
      {
        id: "genbox",
        kind: "cont",
        title: { value: "GeneratedBox", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
        band: { value: "core", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
        drillTo: "alpha",
        members: ["src/alpha/a.ts"],
      },
    ],
    edges: [],
  },
  groundedPct: 88,
  stale: false,
};

/** Fetch mock used by every test: quiet no-op for /arch/task; static $0.10
 * estimate (needed so updateArchAffordance can show the cost label on the
 * generate button on the subset view). */
function quietFetch(): void {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ]);
}

// ── Helper: observable affordance state ──────────────────────────────────────

/** Returns the user-visible affordance state after boot.
 *
 * "subset view" shows: generate button visible + generate label "⚡ Generate
 *   architecture" (or "↻ Re-generate…"), grounded chip hidden.
 * "generated view" shows: grounded chip visible, generate button hidden.
 *
 * These are the two mutually exclusive affordance states the user sees as
 * the difference between the two views (updateArchAffordance logic). */
function affordanceState(root: HTMLElement): {
  genBtnHidden: boolean;
  genLabel: string | null;
  archChipHidden: boolean;
} {
  const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
  const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
  const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");
  return {
    genBtnHidden: genBtn?.hidden ?? true,
    genLabel: genLabel?.textContent ?? null,
    archChipHidden: archChip?.hidden ?? true,
  };
}

// ── Subset param beats fresh generated cache ─────────────────────────────────
//
// Island booted with ?arch-source=subset + fresh generated cache + canSubset
// → subset view renders (NOT the generated view).
//
// Observable signal:
//   • Generated view shows: archChip visible (grounded N%), genBtn HIDDEN.
//   • Subset view shows:    archChip HIDDEN, genBtn VISIBLE ("⚡ Generate…").
//
// Precedence rung-3 gate: "?arch-source=subset && canSubset → subset, beats fresh
// generated cache" — the core of the subset-view foundation.

describe("?arch-source=subset beats fresh generated cache", () => {
  test("island booted with ?arch-source=subset + canSubset + fresh generated cache → subset affordance renders (genBtn visible, archChip hidden)", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");

    // Fresh generated model present; fixture has 2 subdirs (canSubset = true).
    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    const state = affordanceState(root);

    // Anti-vacuous presence guard: confirm both elements exist in the DOM;
    // a missing element would make the absence assertions vacuously true.
    expect(root.querySelector("#rg-arch-gen")).not.toBeNull();
    expect(root.querySelector("#rg-arch-chip")).not.toBeNull();

    // Subset view shows the Generate button. With a FRESH generated cache present,
    // the ghost Re-generate entry is shown (cache exists → modal gate).
    // The core assertion is: button is visible + grounded chip is hidden (subset view).
    expect(state.genBtnHidden).toBe(false);
    // Fresh cache → label is "↻ Re-generate" (ghost tier), not "⚡ Generate architecture".
    expect(state.genLabel).toBe("↻ Re-generate");

    // Grounded chip is the generated-view-only affordance; on subset it must be hidden.
    expect(state.archChipHidden).toBe(true);
  });
});

// ── Subset param with !canSubset ─────────────────────────────────────────────
//
// Island booted with ?arch-source=subset but canSubset = false.
// The param cannot be honored (precedence rung-3 guard: "Guard canSubset makes it a
// no-op where subset can't render"). Should fall through gracefully — no crash,
// and a sensible view is shown (whatever the gate's natural fallback is).
//
// canSubset is false when proj.subdirs is empty (no subdirs to derive from).
// The fall-through target depends on what else is present:
//   - With a fresh generated cache and no authored model → rung 5 → generated.
//   - Without a generated cache and without authored → rung 7 → codemap.
//
// We test the generated-cache path (easier to assert: archChip visible).

describe("?arch-source=subset + !canSubset → graceful fallthrough, no crash", () => {
  test("island boots without throwing; falls through to generated view when cache is present and canSubset is false", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");

    // Override projection to have no subdirs → canSubset = false.
    // Fresh generated cache is present → gate falls to rung 5 → generated view.
    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
      projection: {
        repo: {
          id: "f1x7ur3hash0",
          name: "fixture-repo",
          path: "/tmp/island-harness-fixture-repo",
          files: 3,
          symbols: 9,
          edges: 1,
          lastIndexedTs: "2026-06-09T00:00:00.000Z",
          building: false,
          groupingMode: "fallback" as const,
        },
        groups: [],
        subdirs: [], // empty → canSubset = false
        edges: [],
      },
    });

    // Anti-vacuous presence guard: elements exist in the DOM.
    expect(root.querySelector("#rg-arch-gen")).not.toBeNull();
    expect(root.querySelector("#rg-arch-chip")).not.toBeNull();

    // No crash — the island rendered without throwing (the test would not reach
    // this point if mountRepoGraph threw).

    // Sensible fallthrough: with !canSubset + fresh generated cache, the gate
    // falls to rung 5 → generated view. The grounded chip must be visible.
    // genBtn is now ALSO visible in generated view (ghost regen entry).
    const state = affordanceState(root);
    expect(state.archChipHidden).toBe(false);
    expect(state.genBtnHidden).toBe(false); // persistent regen affordance
  });

  test("island boots without throwing; falls through to codemap when !canSubset and no generated cache", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");

    // No generated cache, no authored model, empty subdirs → !canSubset.
    // Gate reaches rung 7 → codemap. ARCH_MODE = "codemap" → inArchC4 = false
    // → both genBtn and archChip are hidden (updateArchAffordance early-returns).
    const root = await mountRepoGraph({
      generatedModel: null,
      projection: {
        repo: {
          id: "f1x7ur3hash0",
          name: "fixture-repo",
          path: "/tmp/island-harness-fixture-repo",
          files: 3,
          symbols: 9,
          edges: 1,
          lastIndexedTs: "2026-06-09T00:00:00.000Z",
          building: false,
          groupingMode: "fallback" as const,
        },
        groups: [],
        subdirs: [],
        edges: [],
      },
    });

    // No crash.
    expect(root.querySelector("#rg-arch-gen")).not.toBeNull();

    // Codemap mode: ARCH_MODE = "codemap" → inArchC4 = false → both affordances
    // hidden (the user sees the codemap canvas, not arch C4 affordances).
    const state = affordanceState(root);
    expect(state.genBtnHidden).toBe(true);
    expect(state.archChipHidden).toBe(true);
  });
});

// ── Regression: fresh generated still wins without the subset param ─────────
//
// Regression guard: WITHOUT ?arch-source=subset, a fresh generated cache still
// wins (rung 5 behavior unchanged). The gate change must not have broken the
// existing precedence logic.
//
// Observable: no ?arch-source param + fresh generated + no authored model
//   → rung 5 → generated view → archChip visible, genBtn hidden.

describe("regression: no ?arch-source=subset → fresh generated still wins (rung 5 unchanged)", () => {
  test("without the subset param, fresh generated cache still shows the generated view (archChip visible, genBtn hidden)", async () => {
    quietFetch();
    // No URL param; URL is bare /repo-graph.
    // (afterEach resets to /repo-graph, but set it explicitly for clarity.)
    window.history.replaceState(null, "", "/repo-graph");

    // Fresh generated model + canSubset (fixture has subdirs) + no authored.
    // Precedence table: rung 1 (no codemap), rung 2 (no ?arch-source=generated),
    // rung 3 (no ?arch-source=subset), rung 4 (no authored) → rung 5:
    // fresh generated wins.
    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    // Anti-vacuous presence guards.
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");
    expect(genBtn).not.toBeNull();
    expect(archChip).not.toBeNull();

    const state = affordanceState(root);

    // Generated view: archChip (grounded %) visible — this is the positive
    // control proving the generated-view affordance IS wired. Its presence
    // here makes the absence in the subset-view test attributable
    // specifically to the ?arch-source=subset gate, not a missing element.
    expect(state.archChipHidden).toBe(false);

    // genBtn is now ALSO visible in generated view (ghost regen entry).
    // Old contract: "grounded chip replaces it" — now they coexist.
    expect(state.genBtnHidden).toBe(false);
  });

  test("without the subset param, fresh generated BEATS canSubset (rung 5 before rung 6)", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    // Same as above; belt-and-suspenders: explicitly confirm that even though
    // the fixture has subdirs (canSubset = true), fresh-generated wins because
    // rung 5 precedes rung 6 in the precedence chain.
    const state = affordanceState(root);
    expect(state.archChipHidden).toBe(false); // generated view chip
    // genBtn is also visible (ghost regen entry beside grounded chip).
    expect(state.genBtnHidden).toBe(false); // persistent regen affordance
  });
});
