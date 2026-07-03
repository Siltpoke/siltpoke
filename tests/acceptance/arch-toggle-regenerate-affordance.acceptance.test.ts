/**
 * arch-toggle-regenerate-affordance.acceptance.test.ts — ACCEPTANCE tests for
 * the persistent re-generate affordance.
 *
 * SCOPE — persistent re-generate affordance:
 *   Re-generate entry reachable in every previously-hidden state
 *          (viewing-generated; authored-view-fresh).
 *   Click → confirm modal shows est cost line, "replacement" copy with
 *          freshness note; Cancel is the visual default (document.activeElement).
 *   Cancel / Escape / backdrop → zero /arch/generate calls; confirm → 1.
 *   Stale: rg-btn-accent + "↻ Re-generate — code changed";
 *          Fresh: rg-btn-ghost + bare "↻ Re-generate" + muted hint.
 *   No-cache path fires directly; single click, NO modal.
 *   Contingency: estimate 500 → modal opens, "estimate unavailable", confirm enabled.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Island booted via mountRepoGraph() (SSR → registerRepoGraph → factory →
 *     init; same path as real page, no Alpine pipeline).
 *   • Assertions target: element visibility / CSS classes / textContent, fetch
 *     call counts, modal presence/absence, document.activeElement.
 *   • No assertions on internal C4 node content — unit-test territory.
 *
 * NON-DUPLICATION with unit tests
 * (repo-graph-regen-affordance.test.ts, 26 tests):
 *   That file covers the pure archAffordanceState() function matrix + isolated
 *   DOM cases per fixture variant. This file boots the island end-to-end (full
 *   init() path) and asserts each behavior at the user-observable interaction level —
 *   the island's click handler, async estimate fetch, modal open/close, and
 *   generate call count — without duplicating the per-cell matrix.
 *
 * Anti-vacuous discipline:
 *   • Every "absence" assertion paired with a presence guard (element in DOM).
 *   • BEFORE state verified before every click so changes are attributable.
 *   • Fetch spy positive control: estimate call count verified to be ≥ 1 before
 *     asserting generate call count = 0, ruling out "spy never installed" false zero.
 *   • No shared Response objects; each test installs its own fetch mock.
 *
 * Run: bun test tests/acceptance/arch-toggle-regenerate-affordance.acceptance.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  deferred,
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
  // Reset URL; remove any lingering confirm-modal overlays from failed tests.
  window.history.replaceState(null, "", "/repo-graph");
  document.querySelectorAll("[data-confirm-modal]").forEach((el) => el.remove());
  document.body.style.overflow = "";
});

// ── Shared fixtures ───────────────────────────────────────────────────────────

const GEN_DOC = {
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
};

/** Fresh generated model (stale = false). */
const FRESH_GENERATED = { doc: GEN_DOC, groundedPct: 88, stale: false };
/** Stale generated model (stale = true). */
const STALE_GENERATED = { doc: GEN_DOC, groundedPct: 88, stale: true };

/** Minimal authored C4 model (satisfies hasAuthored = true). */
const AUTHORED_C4 = {
  N: {},
  E: [],
  BANDS: [],
  BOUNDARY: { x: 0, y: 0, w: 1500, h: 1170, label: "fixture-authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};

/** One microtask tick — lets async IIFE continuations settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Get the confirm-modal overlay (null if absent). */
function getOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-confirm-modal]");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function genBtnEl(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>("#rg-arch-gen");
}
function genLabelEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("#rg-arch-gen-label");
}
function archChipEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("#rg-arch-chip");
}
function genCostEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("#rg-arch-gen-cost");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Re-generate reachable in previously-hidden states
// ═══════════════════════════════════════════════════════════════════════════════
//
// Previously two states unconditionally hid genBtn:
//   1. archSource === "generated"  (viewing-generated)
//   2. authored view + fresh cache (authored-view-fresh)
//
// Now: button is visible in BOTH states.

describe("fresh generated, viewing-generated view → genBtn visible", () => {
  test("island boot with fresh generated cache, no URL param → archSource=generated, genBtn visible alongside archChip", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.10 } }))],
    ]);

    // No URL param + fresh generated → rung 5 → archSource = "generated".
    window.history.replaceState(null, "", "/repo-graph");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    // Anti-vacuous presence guards: both affordance elements must exist in DOM.
    const genBtn = genBtnEl(root);
    const archChip = archChipEl(root);
    expect(genBtn).not.toBeNull();
    expect(archChip).not.toBeNull();

    // BEFORE state: grounded chip is visible (we are in generated view).
    expect(archChip!.hidden).toBe(false);

    // genBtn must ALSO be visible — the previously-hidden "viewing-generated"
    // state is no longer hidden.
    expect(genBtn!.hidden).toBe(false);
  });
});

describe("authored view + fresh generated cache → genBtn visible (ghost, not hidden)", () => {
  test("authored view with a fresh generated cache: genBtn is visible beside the authored diagram", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.10 } }))],
    ]);

    // Authored view: no ?arch-source param + hasAuthored=true → rung 4 → authored.
    window.history.replaceState(null, "", "/repo-graph");
    const root = await mountRepoGraph({
      authoredModel: AUTHORED_C4,
      generatedModel: FRESH_GENERATED,
    });
    await tick();

    // Anti-vacuous presence guards.
    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    expect(root.querySelector("#rg-arch-gen-label")).not.toBeNull();

    // authored-view + fresh cache must expose genBtn (previously hidden).
    expect(genBtn!.hidden).toBe(false);

    // The label must be the ghost "↻ Re-generate" variant (fresh, not stale).
    const label = genLabelEl(root);
    expect(label?.textContent).toBe("↻ Re-generate");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Click re-generate (cache present) → confirm modal
// ═══════════════════════════════════════════════════════════════════════════════
//
// Modal must show:
//   • Title: "Re-generate diagram?"
//   • Body line 1: cost line (≈$X · Claude) or "estimate unavailable"
//   • Body line 2: replacement/freshness copy (contains "replaced" or "outdated")
//   • Cancel is document.activeElement (visual default, receives focus on open)
//   • Confirm button reads bare "Re-generate" (cost prints once, in the body)

describe("click re-generate (fresh cache) → confirm modal content and cancel focus", () => {
  test("modal title is 'Re-generate diagram?'", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.25 } }))],
    ]);

    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    // BEFORE state: button is visible before click.
    expect(genBtn!.hidden).toBe(false);

    genBtn!.click();
    await tick();
    await tick(); // allow estimate fetch to settle

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const titleEl = overlay!.querySelector<HTMLElement>("[data-modal-title]");
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent).toBe("Re-generate diagram?");

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("modal body contains a cost line (≈$ from estimate) and a freshness/replacement line", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } }))],
    ]);

    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();

    const bodyText = bodyEl!.textContent ?? "";

    // Cost line: must contain the estimate (≈$0.35 from mock).
    expect(bodyText).toContain("≈$0.35");

    // Consequence line: fresh cache → "will replace it" copy.
    expect(bodyText.toLowerCase()).toContain("will replace it");

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("stale cache: modal body contains 'code changed' (stale variant)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } }))],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();

    // Stale variant: "outdated — code changed since last generation."
    expect((bodyEl!.textContent ?? "").toLowerCase()).toContain("code changed");

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("Cancel button is document.activeElement when modal opens (visual default / focus)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.25 } }))],
    ]);

    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const cancelBtn = overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]");
    expect(cancelBtn).not.toBeNull();

    // Cancel receives focus on open (it is the visual default).
    // The confirm-modal primitive calls cancelBtn.focus() synchronously on append.
    expect(document.activeElement).toBe(cancelBtn);

    cancelBtn!.click();
    await tick();
  });

  test("confirm button reads bare 'Re-generate'; cost lives once in the body line", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.42 } }))],
    ]);

    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull();

    // Bare label; the ≈$ prints ONCE — in the
    // consequence line directly above the buttons, asserted here as the pair.
    expect(confirmBtn!.textContent).toBe("Re-generate");
    expect(confirmBtn!.textContent).not.toContain("≈$");
    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl?.textContent).toContain("≈$0.42");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cancel paths: zero /arch/generate calls
// ═══════════════════════════════════════════════════════════════════════════════
//
// Positive control anti-vacuous: verify estimate WAS called (spy is live)
// before asserting generate = 0. Rules out "spy not installed / never hit".

describe("cancel button → zero generate calls (fetch spy positive control)", () => {
  test("cancel click → modal gone, estimate was called (spy live), generate NOT called", async () => {
    let estimateCalls = 0;
    let generateCalls = 0;
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => {
          estimateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.30 } }));
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "should-not-fire" }));
        },
      ],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    // BEFORE: modal is absent.
    expect(getOverlay()).toBeNull();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    // Modal is open.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    // Cancel.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();

    // Modal is gone.
    expect(getOverlay()).toBeNull();

    // Positive control: estimate was called (spy is wired correctly).
    expect(estimateCalls).toBeGreaterThanOrEqual(1);

    // Generate was NOT called.
    expect(generateCalls).toBe(0);
  });
});

describe("Escape key → zero generate calls", () => {
  test("Escape keydown → modal dismissed, generate NOT called", async () => {
    let estimateCalls = 0;
    let generateCalls = 0;
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => {
          estimateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.30 } }));
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "should-not-fire" }));
        },
      ],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    expect(getOverlay()).not.toBeNull();

    // Dispatch Escape.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    expect(getOverlay()).toBeNull();

    // Positive control.
    expect(estimateCalls).toBeGreaterThanOrEqual(1);

    // Generate not called.
    expect(generateCalls).toBe(0);
  });
});

describe("backdrop click → zero generate calls", () => {
  test("clicking the overlay backdrop → modal dismissed, generate NOT called", async () => {
    let estimateCalls = 0;
    let generateCalls = 0;
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => {
          estimateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.30 } }));
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "should-not-fire" }));
        },
      ],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    // Simulate backdrop click (click on the overlay element itself, not the dialog inside).
    // MouseEvent with target = overlay — matches the onBackdropClick guard in confirm-modal.
    overlay!.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    await tick();

    expect(getOverlay()).toBeNull();

    // Positive control.
    expect(estimateCalls).toBeGreaterThanOrEqual(1);

    // Generate not called.
    expect(generateCalls).toBe(0);
  });
});

describe("confirm → exactly one /arch/generate call", () => {
  test("confirm click → overlay removed, exactly one generate call made", async () => {
    let generateCalls = 0;
    const pollDeferred = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1
            ? Promise.resolve(jsonResponse({ data: { task: null } }))
            : pollDeferred.promise;
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "t-confirm-d" }));
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.30 } })),
      ],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    // BEFORE: modal absent, generate = 0.
    expect(getOverlay()).toBeNull();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]")!.click();
    await tick();

    // Modal closes on confirm.
    expect(getOverlay()).toBeNull();

    // Exactly one generate call.
    expect(generateCalls).toBe(1);

    // Settle the hanging poll to avoid leaked promises.
    pollDeferred.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-confirm-d",
            kind: "arch_generate",
            status: "done",
            repo: "f1x7ur3hash0",
            startedTs: "2026-06-11T00:00:00.000Z",
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Button styling tiers: stale vs fresh
// ═══════════════════════════════════════════════════════════════════════════════

describe("stale cache → rg-btn-accent + 'code changed' label", () => {
  test("stale generated: genBtn has rg-btn-accent class and stale label text", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } }))],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    // Anti-vacuous: button is visible.
    expect(genBtn!.hidden).toBe(false);

    // Stale → accent tier.
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(true);
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(false);

    const label = genLabelEl(root);
    expect(label?.textContent).toBe("↻ Re-generate — code changed");
  });
});

describe("fresh cache → rg-btn-ghost + bare 'Re-generate' label + muted hint", () => {
  test("fresh generated (subset view): genBtn has rg-btn-ghost class, bare label, muted cost hint after estimate", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.18 } }))],
    ]);

    // Explicit subset view so we land in the fresh-ghost path.
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    // Fresh → ghost tier.
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(true);
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(false);

    // Label is bare "↻ Re-generate".
    const label = genLabelEl(root);
    expect(label?.textContent).toBe("↻ Re-generate");

    // Muted hint element (#rg-arch-gen-cost) must be present and contain
    // "Diagram is current" after the affordance renders.
    // The Re-generate button no longer shows ≈$ in the cost
    // span (≈$ lives in the confirm modal body only). fetchArchEstimate stores
    // archEstUsd for the modal but suppresses the button write on the fresh-cache
    // path. What IS observable: the cost element shows the hint text, NOT ≈$.
    const cost = genCostEl(root);
    expect(cost).not.toBeNull();
    // Cost element is non-empty — user sees a cost label.
    expect((cost!.textContent ?? "").length).toBeGreaterThan(0);
    // Fresh-cache: hint text present, ≈$ absent from button (lives in modal body).
    expect(cost!.textContent).toContain("Diagram is current");
    expect(cost!.textContent).not.toContain("≈$");
  });

  test("fresh generated (generated view — previously hidden): ghost class + bare label", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.18 } }))],
    ]);

    // No URL param: rung 5 → generated view.
    window.history.replaceState(null, "", "/repo-graph");
    const root = await mountRepoGraph({ generatedModel: FRESH_GENERATED });
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    // Viewing-generated + fresh → ghost, bare label.
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(true);

    const label = genLabelEl(root);
    expect(label?.textContent).toBe("↻ Re-generate");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// No-cache: single click fires generate directly, NO modal
// ═══════════════════════════════════════════════════════════════════════════════

describe("no generated cache → click fires directly, no modal", () => {
  test("no cache: genBtn click fires /arch/generate once; no [data-confirm-modal] in DOM", async () => {
    let generateCalls = 0;
    const pollDeferred = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1
            ? Promise.resolve(jsonResponse({ data: { task: null } }))
            : pollDeferred.promise;
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "t-direct-d" }));
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } })),
      ],
    ]);

    // No generatedModel → no cache.
    const root = await mountRepoGraph();
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    // Anti-vacuous: button is visible.
    expect(genBtn!.hidden).toBe(false);

    // BEFORE: no modal in DOM.
    expect(getOverlay()).toBeNull();

    genBtn!.click();
    await tick();

    // NO modal should have opened (direct-fire path).
    expect(getOverlay()).toBeNull();

    // Exactly one generate call.
    expect(generateCalls).toBe(1);

    // Settle the poll.
    pollDeferred.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-direct-d",
            kind: "arch_generate",
            status: "done",
            repo: "f1x7ur3hash0",
            startedTs: "2026-06-11T00:00:00.000Z",
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
  });

  test("no cache: the generate button has neither rg-btn-accent nor rg-btn-ghost class (default styling)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
    ]);

    const root = await mountRepoGraph();
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    // No cache → default (neither accent nor ghost).
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(false);
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contingency — estimate endpoint failure → modal opens, "estimate unavailable"
// ═══════════════════════════════════════════════════════════════════════════════

describe("Contingency — estimate-fail → modal opens with 'estimate unavailable', confirm enabled", () => {
  test("estimate endpoint returns 500/network error → modal still opens, body contains 'estimate unavailable', confirm not disabled", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      // Estimate fails with network error.
      ["/arch/estimate", () => Promise.reject(new Error("network failure"))],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "should-not-reach" })),
      ],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    genBtn!.click();
    await tick();
    await tick(); // extra tick for failed fetch to settle

    // Modal must open despite estimate failure.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();

    // "estimate unavailable" must appear in modal body.
    expect((bodyEl!.textContent ?? "").toLowerCase()).toContain("estimate unavailable");

    // Confirm button must be enabled (gate is the click, not the number).
    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn!.disabled).toBe(false);

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("estimate returns non-success response → modal opens, 'estimate unavailable', confirm enabled", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: false, error: "too many tokens" }))],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "should-not-reach" })),
      ],
    ]);

    const root = await mountRepoGraph({ generatedModel: STALE_GENERATED });
    await tick();

    genBtnEl(root)!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect((bodyEl?.textContent ?? "").toLowerCase()).toContain("estimate unavailable");

    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn!.disabled).toBe(false);

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});
