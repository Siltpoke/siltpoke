/**
 * arch-toggle-regenerate-chip-roundtrip.acceptance.test.ts — ACCEPTANCE tests for
 * chip round-trip behavior of the arch-toggle-regenerate track.
 *
 * SCOPE (diff: src/web/client/islands/repo-graph.ts, 23+/6-):
 *   - Non-authored repo + generated model → src chip shows "Auto | Generated".
 *   - Full click round-trip: clicking Auto-seg switches to subset view;
 *          clicking Generated-seg switches back.
 *   - Authored repos: chip still reads "Authored | Generated"; no third
 *          segment; subset never surfaces in the authored branch.
 *   - Repo-generic: no repo-name/path special-casing (verified by diff inspection).
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Island booted through the same mountRepoGraph() path as sibling tests.
 *   • Assertions target: chip visibility, segment text content, active/inactive
 *     CSS classes, genBtn visibility (subset view vs generated view affordance),
 *     and URL ?arch-source= param after a click.
 *   • No assertions on internal C4 model content or raw HTML of the generated
 *     diagram — that is unit-test territory (repo-graph-arch-source-gate.test.ts).
 *
 * Anti-vacuous discipline:
 *   • Every "hidden" / "absent CSS class" assertion is paired with an explicit
 *     presence guard that proves the element IS in the DOM, ruling out vacuous pass.
 *   • Click round-trip tests explicitly verify the BEFORE state before firing the
 *     click, confirming the element is wired before trusting the AFTER assertion.
 *   • No shared Response objects; each test installs its own fetch mock.
 *
 * Run: bun test tests/acceptance/arch-toggle-regenerate-chip-roundtrip.acceptance.test.ts
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

/** Fresh generated model — same fixture as sibling tests. */
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

/** Minimal C4Model that satisfies authoredPayload (hasAuthored = true).
 * The renderer only iterates N / E / BANDS + reads BOUNDARY / GROUP_ACCENT;
 * an empty-but-shaped model renders without error. */
const AUTHORED_C4_MODEL = {
  N: {},
  E: [],
  BANDS: [],
  BOUNDARY: { x: 0, y: 0, w: 1500, h: 1170, label: "fixture-authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};

/** Fetch mock used by all tests: quiet no-op for /arch/task; $0.10 estimate. */
function quietFetch(): void {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read chip visibility + segment labels + active state. */
function chipState(root: HTMLElement): {
  chipHidden: boolean;
  leftSegText: string | null;
  rightSegText: string | null;
  leftActive: boolean;
  rightActive: boolean;
} {
  const chip = root.querySelector<HTMLElement>("#rg-src-chip");
  const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
  const rightSeg = root.querySelector<HTMLButtonElement>("#rg-src-generated");
  return {
    chipHidden: chip?.hidden ?? true,
    leftSegText: leftSeg?.textContent?.trim().replace(/\s+/g, " ").replace(" ·stale", "") ?? null,
    rightSegText: rightSeg?.textContent?.trim().replace(/\s+/g, " ").replace(" ·stale", "") ?? null,
    leftActive: leftSeg?.classList.contains("active") ?? false,
    rightActive: rightSeg?.classList.contains("active") ?? false,
  };
}

/** Read the generate-button affordance state. */
function genBtnState(root: HTMLElement): {
  genBtnHidden: boolean;
  genLabel: string | null;
} {
  const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
  const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
  return {
    genBtnHidden: genBtn?.hidden ?? true,
    genLabel: genLabel?.textContent ?? null,
  };
}

// ── Non-authored repo + generated model ─────────────────────────────────────
//
// Non-authored repo + fresh generated cache + canSubset (fixture default) →
// the src chip is VISIBLE and the left segment reads "Auto" (not "Authored").
// Before the diff, updateSrcChip() hid the chip entirely for non-authored repos
// (srcChip.hidden = !(inArchC4 && hasAuthored)).
// After the diff: hasGenerated && canSubset also makes it visible with "Auto".
//
// Boot state: no URL param + fresh generated → rung 5 → archSource = "generated"
// → updateSrcChip → segAuthored.textContent = "Auto", chip visible.

describe("non-authored repo + generated model → chip shows Auto | Generated", () => {
  test("chip is visible and left segment reads 'Auto' (not 'Authored')", async () => {
    quietFetch();
    // No URL param — fresh generated wins at rung 5.
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
      // authoredModel absent → hasAuthored = false (fixture default)
    });

    // Anti-vacuous presence guards: both elements must exist.
    const chip = root.querySelector("#rg-src-chip");
    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    const rightSeg = root.querySelector<HTMLButtonElement>("#rg-src-generated");
    expect(chip).not.toBeNull();
    expect(leftSeg).not.toBeNull();
    expect(rightSeg).not.toBeNull();

    const cs = chipState(root);

    // Core: chip must be visible.
    expect(cs.chipHidden).toBe(false);

    // Left segment reads "Auto" — the non-authored label pair.
    expect(cs.leftSegText).toBe("Auto");

    // Right segment still reads "Generated".
    expect(cs.rightSegText).toBe("Generated");
  });

  test("chip is visible when archSource starts at 'generated' — generated segment is active", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    // Presence guard.
    expect(root.querySelector("#rg-src-chip")).not.toBeNull();

    const cs = chipState(root);
    // Generated view: Generated segment active, Auto segment NOT active.
    expect(cs.rightActive).toBe(true);
    expect(cs.leftActive).toBe(false);
  });

  test("chip is hidden when canSubset = false and no authored model (gate: canSubset && hasGenerated must both be true)", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    // canSubset = false: no subdirs → chip gate fails (no authored, no canSubset)
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
        subdirs: [], // canSubset = false
        edges: [],
      },
    });

    // Anti-vacuous: chip element IS in the DOM (just hidden).
    expect(root.querySelector("#rg-src-chip")).not.toBeNull();

    const cs = chipState(root);
    // Gate: canSubset=false && hasAuthored=false → chip hidden.
    expect(cs.chipHidden).toBe(true);
  });
});

// ── Click round-trip: Auto ↔ Generated ──────────────────────────────────────
//
// Full click round-trip on a non-authored repo:
//   1. Boot with generated view (rung 5 — fresh generated, no URL param).
//   2. Click "Auto" segment → applySource("subset") fires → archSource = "subset"
//      → render() → updateArchAffordance: subset view (genBtn visible, archChip hidden)
//      → updateSrcChip: leftSeg active, rightSeg not active.
//      URL gains ?arch-source=subset.
//   3. Click "Generated" segment → applySource("generated") fires → archSource = "generated"
//      → render() → generated view restored.
//      URL has ?arch-source=generated.
//
// applySource() calls render(true) synchronously. No await needed between click and assertion.

describe("click round-trip: Auto→subset, Generated→generated", () => {
  test("clicking Auto segment switches to subset view (genBtn visible, archChip hidden, leftSeg active)", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    // Anti-vacuous pre-click presence guard: chip must be visible in generated view.
    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    expect(chip).not.toBeNull();
    expect(leftSeg).not.toBeNull();

    // Confirm BEFORE state: chip visible, Generated segment active (generated view).
    const beforeChip = chipState(root);
    expect(beforeChip.chipHidden).toBe(false);
    expect(beforeChip.rightActive).toBe(true);   // Generated is active
    expect(beforeChip.leftActive).toBe(false);   // Auto is NOT active yet

    // Click the "Auto" segment.
    leftSeg!.click();

    // AFTER: subset view.
    const afterGen = genBtnState(root);
    const afterChip = chipState(root);

    // Subset view: genBtn is visible (offer to generate from subset).
    expect(afterGen.genBtnHidden).toBe(false);

    // archChip (grounded %) is hidden in subset view.
    const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");
    expect(archChip).not.toBeNull();
    expect(archChip!.hidden).toBe(true);

    // src chip stays visible; Auto seg becomes active, Generated not.
    expect(afterChip.chipHidden).toBe(false);
    expect(afterChip.leftActive).toBe(true);     // Auto is now active
    expect(afterChip.rightActive).toBe(false);   // Generated is not

    // URL should now carry ?arch-source=subset.
    const urlParam = new URL(location.href).searchParams.get("arch-source");
    expect(urlParam).toBe("subset");
  });

  test("after clicking Auto, clicking Generated restores the generated view", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    const rightSeg = root.querySelector<HTMLButtonElement>("#rg-src-generated");
    expect(leftSeg).not.toBeNull();
    expect(rightSeg).not.toBeNull();

    // Step 1: click Auto → subset view.
    leftSeg!.click();

    // Confirm intermediate: subset view is in effect.
    const midGen = genBtnState(root);
    expect(midGen.genBtnHidden).toBe(false); // subset view shows genBtn

    // Step 2: click Generated → back to generated view.
    rightSeg!.click();

    // AFTER: generated view restored.
    const afterGen = genBtnState(root);
    const afterChip = chipState(root);
    const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");

    // genBtn is now ALSO visible in generated view (ghost regen entry).
    // Grounded chip stays visible; button renders beside it.
    expect(afterGen.genBtnHidden).toBe(false); // persistent regen affordance
    expect(archChip).not.toBeNull();
    expect(archChip!.hidden).toBe(false);

    // src chip: Generated segment re-activates.
    expect(afterChip.chipHidden).toBe(false);
    expect(afterChip.rightActive).toBe(true);
    expect(afterChip.leftActive).toBe(false);

    // URL should carry ?arch-source=generated.
    const urlParam = new URL(location.href).searchParams.get("arch-source");
    expect(urlParam).toBe("generated");
  });

  test("URL carries ?arch-source=subset after clicking Auto, clears (or resets) after clicking Generated", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      generatedModel: FRESH_GENERATED_MODEL,
    });

    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    const rightSeg = root.querySelector<HTMLButtonElement>("#rg-src-generated");
    expect(leftSeg).not.toBeNull();
    expect(rightSeg).not.toBeNull();

    leftSeg!.click();
    expect(new URL(location.href).searchParams.get("arch-source")).toBe("subset");

    rightSeg!.click();
    // applySource("generated") sets ?arch-source=generated.
    expect(new URL(location.href).searchParams.get("arch-source")).toBe("generated");
  });
});

// ── Authored repos: chip unchanged ───────────────────────────────────────────
//
// Authored repos: the chip still reads "Authored | Generated".
// When hasAuthored=true, the code enters the "existing path" branch
// (byte-identical label update: segAuthored.textContent = "Authored").
// The left segment click fires applySource("authored") — not subset.
// No third segment appears. The subset option is never offered.

describe("authored repos: chip unchanged at 'Authored | Generated'", () => {
  test("authored repo + generated model → chip shows 'Authored | Generated', not 'Auto | Generated'", async () => {
    quietFetch();
    // Boot with authoredModel — hasAuthored = true.
    // No URL param → rung 4 → authored view.
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      authoredModel: AUTHORED_C4_MODEL,
      generatedModel: FRESH_GENERATED_MODEL,
    });

    // Anti-vacuous presence guards.
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    const rightSeg = root.querySelector<HTMLButtonElement>("#rg-src-generated");
    expect(chip).not.toBeNull();
    expect(leftSeg).not.toBeNull();
    expect(rightSeg).not.toBeNull();

    const cs = chipState(root);

    // Chip is visible (authored + generated → both segments active path exists).
    expect(cs.chipHidden).toBe(false);

    // Left segment reads "Authored" — NOT "Auto".
    expect(cs.leftSegText).toBe("Authored");

    // Right segment still reads "Generated".
    expect(cs.rightSegText).toBe("Generated");
  });

  test("authored repo: left segment click fires applySource('authored'), not 'subset'", async () => {
    quietFetch();
    // Boot with ?arch-source=generated to start on Generated view.
    window.history.replaceState(null, "", "/repo-graph?arch-source=generated");

    const root = await mountRepoGraph({
      authoredModel: AUTHORED_C4_MODEL,
      generatedModel: FRESH_GENERATED_MODEL,
    });

    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    expect(leftSeg).not.toBeNull();

    // Confirm: starting in generated view (Generated seg active).
    const beforeCs = chipState(root);
    expect(beforeCs.rightActive).toBe(true);

    // Click "Authored" segment — for authored repos should switch to authored view.
    leftSeg!.click();

    const afterCs = chipState(root);

    // Authored view: Authored seg active, Generated not.
    expect(afterCs.leftActive).toBe(true);
    expect(afterCs.rightActive).toBe(false);

    // URL should have no ?arch-source param (bare URL = authored default).
    const urlParam = new URL(location.href).searchParams.get("arch-source");
    expect(urlParam).toBeNull();
  });

  test("authored repo: no third segment exists in the DOM", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      authoredModel: AUTHORED_C4_MODEL,
      generatedModel: FRESH_GENERATED_MODEL,
    });

    // Anti-vacuous: confirm the chip has segments.
    expect(root.querySelector("#rg-src-authored")).not.toBeNull();
    expect(root.querySelector("#rg-src-generated")).not.toBeNull();

    // Exactly 2 segments in the chip — no third segment was added.
    const segCount = root.querySelectorAll(".src-seg").length;
    expect(segCount).toBe(2);
  });

  test("authored repo without generated cache: chip still shows (authored-only case, Generated seg is off/inert)", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph");

    const root = await mountRepoGraph({
      authoredModel: AUTHORED_C4_MODEL,
      generatedModel: null, // no generated cache
    });

    // Anti-vacuous: elements are present.
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    expect(chip).not.toBeNull();

    // With authoredModel + no generated: hasAuthored=true, hasGenerated=false.
    // Gate: inArchC4 && (hasAuthored || ...) → TRUE (hasAuthored is true).
    const cs = chipState(root);
    expect(cs.chipHidden).toBe(false);
    expect(cs.leftSegText).toBe("Authored");

    // Generated segment should have "off" class (inert — no generated model yet).
    const rightSeg = root.querySelector<HTMLButtonElement>("#rg-src-generated");
    expect(rightSeg).not.toBeNull();
    expect(rightSeg!.classList.contains("off")).toBe(true);
  });

  // Repo-generic (no special-casing) is verified by diff inspection —
  // not expressible as a runtime test. Anchored here so the deferral is
  // machine-readable, not silently dropped.
  test.todo("repo-generic: verified by diff inspection (no repo-name/path special-casing)", () => {});
});
