/**
 * repo-graph-pagehead-order.test.ts — DOM-order unit tests for the
 * spatial isolation of the paid button.
 *
 * SCOPE — pagehead child order only (pure SSR render, no island boot needed):
 *   1. #rg-arch-gen is the last element child of .pagehead.
 *   2. #rg-src-chip and #rg-arch-gen are NOT adjacent siblings (≥1 element
 *      between them — the hairline divider; see in-test history note).
 *
 * No island boot required: these are static SSR-rendered positions; the island
 * never mutates pagehead child order, only element [hidden] attributes. We use
 * mountRepoGraph() for a full render path, same as sibling island tests.
 *
 * Anti-vacuous discipline:
 *   • Confirm both target elements exist in DOM before asserting order.
 *   • "Last child" test asserts tagName/id match — not just "is last".
 *   • "Not adjacent" test counts elements between them directly.
 *
 * Run: bun test tests/web/client/islands/repo-graph-pagehead-order.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mountRepoGraph, registerDom, unregisterDom, installFetchMock, jsonResponse } from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

describe("pagehead DOM order: #rg-arch-gen is last child", () => {
  test("#rg-arch-gen is the last element child of .pagehead", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    const root = await mountRepoGraph();

    const pagehead = root.querySelector<HTMLElement>(".pagehead");
    expect(pagehead).not.toBeNull(); // anti-vacuous: element exists

    const genBtn = root.querySelector<HTMLElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull(); // anti-vacuous: button in DOM

    const children = Array.from(pagehead!.children);
    const lastChild = children[children.length - 1];
    expect(lastChild?.id).toBe("rg-arch-gen");
  });
});

describe("pagehead DOM order: #rg-src-chip and #rg-arch-gen are NOT adjacent siblings", () => {
  test("NOT adjacent: ≥1 element between #rg-src-chip and #rg-arch-gen in .pagehead", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    const root = await mountRepoGraph();

    const pagehead = root.querySelector<HTMLElement>(".pagehead");
    expect(pagehead).not.toBeNull(); // anti-vacuous

    const children = Array.from(pagehead!.children);

    const chipIdx = children.findIndex((el) => el.id === "rg-src-chip");
    const genIdx = children.findIndex((el) => el.id === "rg-arch-gen");

    // Anti-vacuous: both must exist in the pagehead children
    expect(chipIdx).toBeGreaterThanOrEqual(0);
    expect(genIdx).toBeGreaterThanOrEqual(0);

    // genBtn must come AFTER chip
    expect(genIdx).toBeGreaterThan(chipIdx);

    // ≥1 element between them (the hairline divider). History: round-1 buffer was
    // 4 elements; grounded%/noevi moved left (→2); the /repo-graph route tag
    // was removed in the user's density pass (→1). NOT adjacent remains the floor —
    // the confirm modal is the second protection layer (user-accepted trade-off).
    const elementsBetween = genIdx - chipIdx - 1;
    expect(elementsBetween).toBeGreaterThanOrEqual(1);
  });
});

describe("divider visibility pairs with the button", () => {
  test("codemap mode (no graph data → button hidden) also hides .pagehead-divider", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    // No generated model + empty projection → boot falls through to codemap →
    // updateArchAffordance early-return hides genBtn; divider must follow.
    const root = await mountRepoGraph({
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

    const genBtn = root.querySelector<HTMLElement>("#rg-arch-gen");
    const divider = root.querySelector<HTMLElement>(".pagehead-divider");
    expect(genBtn).not.toBeNull(); // anti-vacuous
    expect(divider).not.toBeNull(); // anti-vacuous

    // Positive control: this fixture really is the hidden-button state.
    expect(genBtn!.hidden).toBe(true);
    // Pre-fix: divider stayed visible (no pairing) → FAIL here.
    expect(divider!.hidden).toBe(true);
  });

  test("fresh generated (button visible) keeps the divider visible", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: {
          boundary: "fx",
          bands: [{ id: "core", label: { value: "B", evidence: [{ file: "src/a.ts", line: 1 }] }, order: 0, members: ["n1"] }],
          nodes: [{ id: "n1", kind: "cont", title: { value: "N1", evidence: [{ file: "src/a.ts", line: 1 }] }, band: { value: "core", evidence: [{ file: "src/a.ts", line: 1 }] }, drillTo: "a", members: ["src/a.ts"] }],
          edges: [],
        },
        groundedPct: 80,
        stale: false,
      },
    });

    const genBtn = root.querySelector<HTMLElement>("#rg-arch-gen");
    const divider = root.querySelector<HTMLElement>(".pagehead-divider");
    expect(genBtn!.hidden).toBe(false); // positive control
    expect(divider!.hidden).toBe(false);
  });

});

// ── Grounded chip relocated to TOOLBAR ───────────────────────────────────────
//
// #rg-arch-chip moved OUT of pagehead and INTO the Architecture toolbar (SSR,
// before ph-bar), adjacent to Trace-a-path. The old assertion (chip before
// src-chip in pagehead) is replaced by:
//   • #rg-arch-chip is NOT in pagehead children (chipIdx === -1).
//   • #rg-arch-chip IS a descendant of .toolbar.
//   • Visibility gating unchanged: hidden on subset view, visible on generated view.
//
// Also: .idx-stat is the immediate next sibling of .repo-pick-wrap
//   (stats beside repo picker, no margin-left:auto on the stats span).
//
// And: confidence chip (#rg-ph-cov) is adjacent to the entry
//   button (#rg-ph-pick) in the ph-bar right cluster (chip immediately before
//   the pick button in innerHTML order).

describe("grounded chip in toolbar, NOT in pagehead", () => {
  test("#rg-arch-chip is NOT in pagehead; IS under .toolbar", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    const root = await mountRepoGraph();

    const pagehead = root.querySelector<HTMLElement>(".pagehead");
    expect(pagehead).not.toBeNull(); // anti-vacuous

    const toolbar = root.querySelector<HTMLElement>(".toolbar");
    expect(toolbar).not.toBeNull(); // anti-vacuous: toolbar exists

    const pageheadChildren = Array.from(pagehead!.children);
    const chipInPagehead = pageheadChildren.findIndex((el) => el.id === "rg-arch-chip");

    // ── (pre-move): chip was IN pagehead (chipIdx >= 0) → FAIL.
    // Chip must NOT be in pagehead.
    expect(chipInPagehead).toBe(-1);

    // Chip must be a descendant of .toolbar after the move.
    const chipInToolbar = toolbar!.querySelector<HTMLElement>("#rg-arch-chip");
    expect(chipInToolbar).not.toBeNull();

    // genBtn is still last (existing invariant — must not break).
    const children = Array.from(pagehead!.children);
    const genIdx = children.findIndex((el) => el.id === "rg-arch-gen");
    expect(genIdx).toBeGreaterThanOrEqual(0);
    expect(genIdx).toBe(children.length - 1);
  });

  test("#rg-arch-chip hidden on subset view (Auto active), visible on generated view", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    // subset view: arch-chip must be hidden (island visibility logic unchanged).
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({
      generatedModel: {
        doc: {
          boundary: "fx",
          bands: [{ id: "core", label: { value: "B", evidence: [{ file: "src/a.ts", line: 1 }] }, order: 0, members: ["n1"] }],
          nodes: [{ id: "n1", kind: "cont", title: { value: "N1", evidence: [{ file: "src/a.ts", line: 1 }] }, band: { value: "core", evidence: [{ file: "src/a.ts", line: 1 }] }, drillTo: "a", members: ["src/a.ts"] }],
          edges: [],
        },
        groundedPct: 80,
        stale: false,
      },
    });

    const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");
    expect(archChip).not.toBeNull(); // anti-vacuous: element must exist (hidden, not removed)

    // Subset view: chip hidden (showGroundedChip = archSource === "generated" = false).
    expect(archChip!.hidden).toBe(true);

    // Switch to generated view: chip must become visible.
    const segGenerated = root.querySelector<HTMLButtonElement>("#rg-src-generated");
    expect(segGenerated).not.toBeNull();
    segGenerated!.click();
    await new Promise((r) => setTimeout(r, 0));

    // Visibility wiring unchanged — relocation must not break it.
    expect(archChip!.hidden).toBe(false);
  });
});

describe("idx-stat is immediate next sibling of repo-pick-wrap in pagehead", () => {
  test("stats span immediately follows repo-pick-wrap (no margin-left:auto push)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    const root = await mountRepoGraph();

    const pagehead = root.querySelector<HTMLElement>(".pagehead");
    expect(pagehead).not.toBeNull();

    const children = Array.from(pagehead!.children);
    const pickWrapIdx = children.findIndex((el) => el.classList.contains("repo-pick-wrap"));
    expect(pickWrapIdx).toBeGreaterThanOrEqual(0); // anti-vacuous

    // ── stats is currently NOT the immediate next sibling → FAIL.
    const nextEl = children[pickWrapIdx + 1];
    expect(nextEl).not.toBeUndefined();
    expect(nextEl?.classList.contains("idx-stat")).toBe(true);
  });
});

