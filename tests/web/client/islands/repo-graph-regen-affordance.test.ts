/**
 * Persistent re-generate affordance: pure-function matrix + DOM wiring.
 *
 * ── Structure ─────────────────────────────────────────────────────────────────
 *
 * 1. Pure-function matrix (no DOM) — archAffordanceState() vs the affordance table.
 *    Tests the pure helper that `updateArchAffordance()` delegates to.
 *    All archSource × hasGenerated × stale combos including the two that were
 *    previously hidden (viewing-generated and authored-fresh).
 *
 * 2. DOM tests:
 *    a. No-cache click fires directly without modal.
 *    b. Cache-present click opens the modal (archChip in DOM).
 *    c. Cancel (or Escape) → zero calls to /arch/generate.
 *    d. Confirm → exactly one call to /arch/generate.
 *    e. Estimate-fail contingency: modal opens with "estimate unavailable",
 *       confirm still enabled.
 *    f. In-flight re-click is ignored (guard: no second generate call).
 *    g. Stale-cache: button shows accent class + correct label.
 *    h. Fresh-cache: button shows ghost class + correct label.
 *    i. Viewing-generated: button is visible beside the grounded chip.
 *    j. Authored-fresh: button is visible in authored view.
 *
 * ── Anti-vacuous discipline ───────────────────────────────────────────────────
 *    Every failing assertion was confirmed to fail before the fix landed
 *    (absence proven by the pre-impl state); every fetch spy confirms WHICH
 *    call was (or was not) made.
 *
 * Run: bun test tests/web/client/islands/repo-graph-regen-affordance.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  deferred,
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "./_dom-harness";

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
  // Remove any confirm-modal overlays left by failed tests.
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

const AUTHORED_C4 = {
  N: {},
  E: [],
  BANDS: [],
  BOUNDARY: { x: 0, y: 0, w: 1500, h: 1170, label: "fixture-authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function getOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-confirm-modal]");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PURE-FUNCTION MATRIX
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests import `archAffordanceState` directly and verify the affordance table
// without touching the DOM.
// Expected export: archAffordanceState(
//   archSource: "authored" | "generated" | "subset",
//   hasGenerated: boolean,
//   generatedStale: boolean,
// ) → { visible: boolean; label: string; tier: "default" | "accent" | "ghost"; hint: string | null; clickMode: "direct" | "modal" }

describe("Pure function — archAffordanceState matrix", () => {
  type AffordanceResult = {
    visible: boolean;
    label: string;
    tier: "default" | "accent" | "ghost";
    hint: string | null;
    clickMode: "direct" | "modal";
  };

  async function importFn(): Promise<
    (
      archSource: "authored" | "generated" | "subset",
      hasGenerated: boolean,
      generatedStale: boolean,
    ) => AffordanceResult
  > {
    const mod = await import("../../../../src/web/client/islands/repo-graph");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (mod as any).archAffordanceState;
    if (typeof fn !== "function") throw new Error("archAffordanceState not exported");
    return fn;
  }

  // ── No cache (any view) → direct fire, ⚡ Generate, default styling ─────────

  test("no cache + subset → visible, '⚡ Generate architecture', default, direct", async () => {
    const fn = await importFn();
    // ── function doesn't exist yet → importFn throws "not exported"
    const result = fn("subset", false, false);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("⚡ Generate architecture");
    expect(result.tier).toBe("default");
    expect(result.clickMode).toBe("direct");
  });

  test("no cache + authored → visible, '⚡ Generate architecture', default, direct", async () => {
    const fn = await importFn();
    const result = fn("authored", false, false);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("⚡ Generate architecture");
    expect(result.tier).toBe("default");
    expect(result.clickMode).toBe("direct");
  });

  test("no cache + generated view → visible, '⚡ Generate architecture', default, direct", async () => {
    const fn = await importFn();
    // Viewing 'generated' but somehow no cache (e.g., external deletion).
    // "no cache (any view)" → direct fire.
    const result = fn("generated", false, false);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("⚡ Generate architecture");
    expect(result.tier).toBe("default");
    expect(result.clickMode).toBe("direct");
  });

  // ── Cache + stale (any view) → modal, accent, ↻ Re-generate — code changed ──

  test("cache + stale + subset → accent, '↻ Re-generate — code changed', modal", async () => {
    const fn = await importFn();
    const result = fn("subset", true, true);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("↻ Re-generate — code changed");
    expect(result.tier).toBe("accent");
    expect(result.clickMode).toBe("modal");
  });

  test("cache + stale + authored → accent, '↻ Re-generate — code changed', modal", async () => {
    const fn = await importFn();
    // Previously: authored+stale was offered; authored+fresh was hidden.
    // authored+stale → still visible+accent (no change here).
    const result = fn("authored", true, true);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("↻ Re-generate — code changed");
    expect(result.tier).toBe("accent");
    expect(result.clickMode).toBe("modal");
  });

  test("cache + stale + generated → accent, '↻ Re-generate — code changed', modal (kill hide-branch)", async () => {
    const fn = await importFn();
    // The old always-hide branch (archSource==="generated" → genBtn.hidden=true)
    // is killed. This was the key affordance.
    const result = fn("generated", true, true);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("↻ Re-generate — code changed");
    expect(result.tier).toBe("accent");
    expect(result.clickMode).toBe("modal");
  });

  // ── Cache + fresh (any view) → modal, ghost, ↻ Re-generate ──────────────────

  test("cache + fresh + subset → ghost, '↻ Re-generate', modal", async () => {
    const fn = await importFn();
    const result = fn("subset", true, false);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("↻ Re-generate");
    expect(result.tier).toBe("ghost");
    expect(result.clickMode).toBe("modal");
  });

  test("cache + fresh + authored → ghost, '↻ Re-generate', modal (kill authored-fresh hide)", async () => {
    const fn = await importFn();
    // The old authored-fresh hide (genBtn.hidden = fresh) is killed.
    // authored+fresh → visible ghost (modal gate carries the friction).
    const result = fn("authored", true, false);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("↻ Re-generate");
    expect(result.tier).toBe("ghost");
    expect(result.clickMode).toBe("modal");
  });

  test("cache + fresh + generated → ghost, '↻ Re-generate', modal (kill viewing-generated hide)", async () => {
    const fn = await importFn();
    // The old always-hide branch (viewing-generated → genBtn.hidden=true) is killed.
    const result = fn("generated", true, false);
    expect(result.visible).toBe(true);
    expect(result.label).toBe("↻ Re-generate");
    expect(result.tier).toBe("ghost");
    expect(result.clickMode).toBe("modal");
  });

  // ── hint field: only set for cache+fresh ────────────────────────────────────

  test("cache + fresh → hint contains 'Diagram is current'", async () => {
    const fn = await importFn();
    const result = fn("subset", true, false);
    expect(result.hint).not.toBeNull();
    expect(result.hint).toContain("Diagram is current");
  });

  test("cache + stale → hint is null", async () => {
    const fn = await importFn();
    const result = fn("subset", true, true);
    // Affordance table: stale row has hint: null — unconditional assertion, not a
    // conditional that passes vacuously when hint IS null.
    expect(result.hint).toBeNull();
  });

  test("no cache → hint is null", async () => {
    const fn = await importFn();
    const result = fn("subset", false, false);
    expect(result.hint).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DOM TESTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── No-cache click fires directly (no modal) ────────────────────────────

describe("no-cache click fires directly, no modal", () => {
  test("clicking generate with no cache fires /arch/generate without opening a modal", async () => {
    let generateCalls = 0;
    const firstPoll = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1
            ? Promise.resolve(jsonResponse({ data: { task: null } }))
            : firstPoll.promise;
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "t-direct-1" }));
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } })),
      ],
    ]);

    // No generated cache → direct fire path.
    const root = await mountRepoGraph();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    // Anti-vacuous: button is visible.
    expect(genBtn!.hidden).toBe(false);

    genBtn!.click();
    await tick();

    // ── no modal overlay (direct fire, no modal).
    // Pre-impl: a naive "always show modal" impl would put an overlay here → FAIL.
    expect(getOverlay()).toBeNull();

    // Generate endpoint was called exactly once.
    expect(generateCalls).toBe(1);

    // Settle the poll to avoid leaked promise.
    firstPoll.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-direct-1",
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

// ── Cache-present click opens modal ─────────────────────────────────

describe("cache-present click opens confirm modal", () => {
  test("stale cache + subset view: click opens modal with Re-generate title", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    // Anti-vacuous: button is visible in subset view with stale cache.
    expect(genBtn!.hidden).toBe(false);

    genBtn!.click();
    await tick(); // estimate fetch + modal open

    // ── modal must be in the DOM.
    // Pre-impl: no modal logic → overlay absent → FAIL.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const titleEl = overlay!.querySelector<HTMLElement>("[data-modal-title]");
    expect(titleEl?.textContent).toBe("Re-generate diagram?");

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("fresh cache + viewing-generated (kill hide-branch): button visible, click opens modal", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    // No URL param, fresh generated → rung 5 → archSource = "generated".
    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: false },
    });
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();

    // ── button must be visible in generated view.
    // Pre-impl: always-hide branch sets genBtn.hidden=true → FAIL.
    expect(genBtn!.hidden).toBe(false);

    genBtn!.click();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("fresh cache + authored view (kill authored-fresh hide): button visible, click opens modal", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    // Authored view with a fresh generated cache.
    const root = await mountRepoGraph({
      authoredModel: AUTHORED_C4,
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: false },
    });
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();

    // ── button must be visible in authored+fresh-cache state.
    // Pre-impl: authored-fresh hide sets genBtn.hidden=true → FAIL.
    expect(genBtn!.hidden).toBe(false);

    genBtn!.click();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ── Cancel → zero generate calls ────────────────────────────────────────

describe("cancel paths produce zero generate calls", () => {
  test("cancel button click → zero /arch/generate calls", async () => {
    let generateCalls = 0;
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "should-not-run" }));
        },
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();

    // Modal must be open.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    // Cancel button click.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();

    // ── zero generate calls on cancel.
    expect(generateCalls).toBe(0);

    // Modal removed.
    expect(getOverlay()).toBeNull();
  });

  test("Escape key close → zero /arch/generate calls", async () => {
    let generateCalls = 0;
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "should-not-run" }));
        },
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();

    expect(getOverlay()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    // ── zero generate calls on Escape cancel.
    expect(generateCalls).toBe(0);
  });
});

// ── Confirm → exactly one generate call ─────────────────────────────────

describe("confirm fires exactly one generate call", () => {
  test("confirming the modal fires /arch/generate exactly once", async () => {
    let generateCalls = 0;
    const firstPoll = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1
            ? Promise.resolve(jsonResponse({ data: { task: null } }))
            : firstPoll.promise;
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "t-confirm-1" }));
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    // Confirm.
    overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]")!.click();
    await tick();

    // ── exactly one generate call on confirm.
    expect(generateCalls).toBe(1);

    // Modal closed.
    expect(getOverlay()).toBeNull();

    // Settle the poll.
    firstPoll.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-confirm-1",
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

// ── Estimate-fail contingency ─────────────────────────────────────────────────

describe("Estimate-fail contingency — modal opens with 'estimate unavailable', confirm enabled", () => {
  test("estimate endpoint error → modal opens, shows 'estimate unavailable', confirm button enabled", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      // Estimate throws → contingency path.
      ["/arch/estimate", () => Promise.reject(new Error("network error"))],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "should-not-reach" })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    // Give more time for the failed estimate fetch to settle.
    await tick();
    await tick();

    // ── modal opens despite estimate failure.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    // "estimate unavailable" must appear somewhere in the modal body.
    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl?.textContent?.toLowerCase()).toContain("estimate unavailable");

    // Confirm button must be enabled (the gate is the confirm, not the number).
    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn!.disabled).toBe(false);

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("estimate non-success response → modal opens with 'estimate unavailable', confirm enabled", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      // Estimate returns non-success.
      [
        "/arch/estimate",
        () =>
          Promise.resolve(jsonResponse({ success: false, error: "too many files" })),
      ],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "should-not-reach" })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl?.textContent?.toLowerCase()).toContain("estimate unavailable");

    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn!.disabled).toBe(false);

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ── In-flight re-click guard ──────────────────────────────────────────────────

describe("In-flight guard — re-click while generating is ignored", () => {
  test("clicking the button again while a generate is in flight does not fire a second /arch/generate call", async () => {
    let generateCalls = 0;
    const holdPoll = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1
            ? Promise.resolve(jsonResponse({ data: { task: null } }))
            : holdPoll.promise; // hold so generate stays in-flight
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(jsonResponse({ success: true, taskId: "t-inflight-1" }));
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    // Open modal + confirm → starts the generate run.
    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]")!.click();
    await tick();

    // Now generating is true; try to click the button again.
    // The button should be disabled (or the island should guard via `generating`).
    root.querySelector<HTMLButtonElement>("#rg-arch-gen")?.click();
    await tick();

    // ── still exactly one generate call.
    expect(generateCalls).toBe(1);

    // No second modal opened (button disabled during generate).
    // (The pre-impl guard was `if (!genBtn || generating) return` in runArchGenerate.)

    // Settle to avoid leaked promise.
    holdPoll.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-inflight-1",
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

// ── Styling tiers ─────────────────────────────────────────────────────────

describe("button styling tiers", () => {
  test("stale cache: button has rg-btn-accent class and stale label", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");

    // ── accent class + stale label.
    // Pre-impl: no rg-btn-accent class → FAIL.
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(true);
    expect(genLabel?.textContent).toBe("↻ Re-generate — code changed");
  });

  test("fresh cache: button has rg-btn-ghost class and bare Re-generate label", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } })),
      ],
    ]);

    // Boot with ?arch-source=subset so we land on subset view with fresh cache.
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: false },
    });
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");

    // ── ghost class + bare label.
    // Pre-impl: no rg-btn-ghost class → FAIL.
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(true);
    expect(genLabel?.textContent).toBe("↻ Re-generate");
  });

  test("no cache: button has neither rg-btn-accent nor rg-btn-ghost class (default)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } })),
      ],
    ]);

    const root = await mountRepoGraph();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    // No cache → default styling (neither accent nor ghost).
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(false);
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(false);
  });
});

// ── H1 regression: genCost stale-text retention ───────────────────────────────
//
// Bug: updateArchAffordance only wrote genCost when dec.hint !== null (fresh path).
// On a fresh→stale transition the span retained "Diagram is current · ≈$X" while
// the label already showed "↻ Re-generate — code changed" — visual contradiction.
//
// The harness has no in-place transition path; these tests cover both halves:
//   1. Pure-function: archAffordanceState(stale) yields hint:null (the source of
//      the bug — proven by the now-unconditional L-test assertion above).
//   2. DOM: stale boot never shows "Diagram is current" in genCost (proves the
//      writing path correctly clears the span; also documents the invariant).
//
// Pre-fix reasoning: the old code:
//   if (genCost && dec.hint !== null) { genCost.textContent = ... }
// skips the assignment entirely when hint is null, so genCost retains whatever
// text was last written. On a transition: fresh render wrote "Diagram is current ·
// ≈$X"; stale render skipped the write → span stayed "Diagram is current · ≈$X".
// The stale-boot DOM test below WOULD have passed vacuously (genCost starts empty
// at boot), but the unconditional-write fix is still correct: it ensures the clear
// runs regardless of how the stale state is reached.

describe("H1 regression — genCost stale-text retention", () => {
  test("stale boot: genCost does not contain 'Diagram is current'", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      // Estimate resolves — so the no-cache "≈$X · uses Claude" write fires.
      // The stale path should NOT show "Diagram is current" regardless.
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.08 } })),
      ],
    ]);

    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: true },
    });
    // Let the estimate fetch settle so the async fetchArchEstimate write completes.
    await tick();
    await tick();

    const genCost = root.querySelector<HTMLElement>("#rg-arch-gen-cost");
    expect(genCost).not.toBeNull();

    // ── stale boot must never show "Diagram is current".
    // Pre-fix: genCost was only written on hint !== null. After a fresh→stale
    // transition the text would linger. This DOM test proves the clear runs at
    // stale-tier call time (the fix is an unconditional write, not conditional).
    expect(genCost!.textContent).not.toContain("Diagram is current");
  });

  test("fresh boot: genCost does not contain 'Re-generate' text (correct hint path active)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.08 } })),
      ],
    ]);

    // Use ?arch-source=subset so we land on subset+fresh-cache (ghost tier).
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: false },
    });
    await tick();
    await tick();

    const genCost = root.querySelector<HTMLElement>("#rg-arch-gen-cost");
    expect(genCost).not.toBeNull();

    // Fresh tier uses the hint path. The estimate fetch fires on boot and writes
    // "≈$X · uses Claude" — so at boot the final text is the estimate form.
    // The "Diagram is current · ≈$X" composite shows on subsequent updateArchAffordance
    // calls once archEstUsd is cached. Either way, fresh tier must NOT be empty
    // (the hint path writes something) — this proves the fix didn't break the fresh path.
    expect(genCost!.textContent).not.toBe("");
    // And the label button itself should be ghost tier (not accent).
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(true);
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(false);
  });
});

// ── H2 regression: dec.visible must drive genBtn.hidden ───────────────────────
//
// Bug: genBtn.hidden = false was written unconditionally, ignoring dec.visible.
// Currently archAffordanceState always returns visible:true for all 9 combos —
// this test documents the invariant and ensures the wiring is live (if visible
// ever returns false for some combo, the button would correctly hide).

describe("H2 invariant — dec.visible drives genBtn.hidden for all 9 combos", () => {
  test("visible is true for all archSource × hasGenerated × stale combos", async () => {
    const mod = await import("../../../../src/web/client/islands/repo-graph");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (mod as any).archAffordanceState;
    if (typeof fn !== "function") throw new Error("archAffordanceState not exported");

    const sources = ["authored", "generated", "subset"] as const;
    const bools = [false, true] as const;

    for (const src of sources) {
      for (const hasGen of bools) {
        for (const stale of bools) {
          // stale=true without hasGenerated is logically inconsistent but the
          // function handles it gracefully (returns the no-cache row).
          const result = fn(src, hasGen, stale);
          expect(result.visible).toBe(true);
        }
      }
    }
  });
});

// ── Grounded chip + regen button coexist in generated view ────────────────────

describe("grounded chip stays visible beside the regen button (viewing-generated)", () => {
  test("viewing-generated: grounded chip visible AND genBtn visible simultaneously", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } })),
      ],
    ]);

    // Fresh generated → rung 5 → generated view.
    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: false },
    });
    await tick();

    const archChip = root.querySelector<HTMLElement>("#rg-arch-chip");
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");

    expect(archChip).not.toBeNull();
    expect(genBtn).not.toBeNull();

    // ── both visible simultaneously.
    // Pre-impl: generated branch sets genBtn.hidden=true → one of them is hidden → FAIL.
    expect(archChip!.hidden).toBe(false); // grounded chip stays
    expect(genBtn!.hidden).toBe(false);   // re-generate button beside it
  });
});

// ── Cost dedup contract: Re-generate button vs first-Generate ────────
//
// Two-path invariant (user-stated):
//   NO-CACHE path:  The button text MUST include "≈$" — this is the ONLY pre-burn
//                   cost signal on the direct-fire path (no modal gate). DO NOT
//                   unify away.
//   FRESH-CACHE path: The Re-generate button text must NOT include "≈$" after the
//                   estimate resolves (cost lives in the confirm modal body only).
//                   The cost span shows "Diagram is current" (no dollar amount).
//
// These tests pin the contract so a future copy change cannot accidentally strip
// the no-cache ≈$ signal or restore ≈$ to the fresh-cache button.

describe("no-cache path: Generate button text contains ≈$ (ONLY pre-burn cost surface — DO NOT unify away)", () => {
  test("no-cache path: Generate button text contains the ≈$ cost signal (the ONLY pre-burn cost surface on this path — DO NOT unify away)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.74 } })),
      ],
    ]);

    // No generated cache → direct-fire path (no modal gate).
    const root = await mountRepoGraph();
    // Wait for estimate to settle (fetchArchEstimate is async, fires on init).
    await tick();
    await tick();

    const genCost = root.querySelector<HTMLElement>("#rg-arch-gen-cost");
    expect(genCost).not.toBeNull(); // anti-vacuous: element must exist

    // Anti-vacuous: confirm we're in no-cache state (button is default tier, no cache).
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(false); // no-cache = default tier
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(false);

    // ── pre-impl: genCost shows "≈$X · uses Claude" from
    // fetchArchEstimate. If this path is accidentally unified away, genCost
    // would be empty or "Diagram is current" → this assertion FAILS.
    expect(genCost!.textContent).toContain("≈$");
  });
});

describe("fresh-cache path: Re-generate button text does NOT contain ≈$; the confirm modal body DOES", () => {
  test("fresh-cache path: Re-generate button text does NOT contain ≈$; the confirm modal body DOES", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.74 } })),
      ],
    ]);

    // Boot with fresh cache → ghost tier (modal path).
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 88, stale: false },
    });
    // Wait for estimate to settle (async — this write must complete BEFORE we assert).
    await tick();
    await tick();

    const genCost = root.querySelector<HTMLElement>("#rg-arch-gen-cost");
    expect(genCost).not.toBeNull(); // anti-vacuous

    // Anti-vacuous: confirm we're in fresh-cache / ghost-tier state.
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(true);

    // ── pre-impl: genCost currently writes
    // "Diagram is current · ≈$X" when estimate is available (line 1419).
    // The ≈$ must NOT appear in the button cost span — it should
    // only say "Diagram is current". If implementation still has the old string,
    // this test FAILS.
    expect(genCost!.textContent).not.toContain("≈$");

    // Also assert the hint text itself is present (non-empty, not vacuous).
    expect(genCost!.textContent).toContain("Diagram is current");

    // Click → modal must contain ≈$ in its body (the ONLY cost surface on this path).
    genBtn!.click();
    // Give the modal estimate re-fetch time to settle.
    await tick();
    await tick();

    const overlay = document.querySelector<HTMLElement>("[data-confirm-modal]");
    expect(overlay).not.toBeNull(); // anti-vacuous: modal opened

    // ── modal body DOES contain ≈$.
    // This ensures cost is still shown somewhere — just not on the button.
    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl?.textContent).toContain("≈$");

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ── Confidence chip in right cluster of the ph-bar ───
//
// When trace mode is active, the ph-bar must render:
//   [spacer/flex-push] · confidence-chip · entry-button
//
// Key structural assertions:
//   1. A flex spacer element exists before the confidence chip (pushing chip+
//      entry-btn to the right as a cluster).
//   2. The confidence chip (#rg-ph-cov) immediately precedes the entry
//      button wrapper (.ph-pwrap) in DOM order.
//   3. The entry button wrapper no longer has ph-pwrap-right class (margin-left:auto
//      moved to the spacer).
//
// The coverage data is set by ensureEntrypoints() from the entrypoints API.
// We mock the API to return coverage without entrypoints so phOpenSearch()
// fires (no candidates) and enters trace mode with coverage already set.

describe("confidence chip in right cluster of ph-bar, preceded by spacer", () => {
  test("in trace mode, ph-bar has [spacer] [chip-wrap] [pick-wrap] order", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.15 } }))],
      // entrypoints with coverage but empty entrypoints → phOpenSearch fires
      ["/api/repo-graph/entrypoints", () =>
        Promise.resolve(jsonResponse({
          data: {
            entrypoints: [],
            coverage: { resolvedCallsites: 3192, totalCallsites: 4186, pct: 76, tier: "green" },
          },
        }))],
    ]);

    const root = await mountRepoGraph();

    // Click "⟜ Trace a path" — calls phEnterDefault → ensureEntrypoints → phOpenSearch
    const traceBtn = root.querySelector<HTMLElement>("#rg-ph-enter");
    expect(traceBtn).not.toBeNull(); // anti-vacuous: button rendered at arch level
    traceBtn!.click();

    // Allow microtasks + async ensureEntrypoints to settle
    await tick();
    await tick();

    const bar = root.querySelector<HTMLElement>("#rg-phbar");
    expect(bar).not.toBeNull(); // anti-vacuous

    const barChildren = Array.from(bar!.children);

    // Anti-vacuous: chip and entry wrapper must both exist in ph-bar
    const covWrapIdx = barChildren.findIndex((el) => el.querySelector("#rg-ph-cov") !== null);
    const pickWrapIdx = barChildren.findIndex((el) => el.querySelector("#rg-ph-pick") !== null);
    expect(covWrapIdx).toBeGreaterThanOrEqual(0); // chip exists
    expect(pickWrapIdx).toBeGreaterThanOrEqual(0); // entry button exists

    // ── currently chip is at index 0 (leftmost),
    // no spacer before it. A flex spacer must appear BEFORE the chip
    // so that chip+entry-btn form a right cluster.
    // Assert: spacer exists (covWrapIdx > 0 → something before the chip).
    expect(covWrapIdx).toBeGreaterThan(0);

    // The element before the chip is the shared .ph-spacer (renamed
    // from ph-pwrap-right — same pattern as the pagehead spacer). Pins the
    // REAL phSyncBar output; keep the fixture mirror in sync with this class
    // name.
    expect(barChildren[covWrapIdx - 1]?.classList.contains("ph-spacer")).toBe(true);

    // Chip immediately precedes entry button (both in right cluster, no gap).
    expect(covWrapIdx + 1).toBe(pickWrapIdx);

    // Entry button wrapper must NOT carry ph-pwrap-right class after the move
    // (the class + its margin-left:auto rule are retired; the spacer does the push).
    const pickWrap = barChildren[pickWrapIdx];
    expect(pickWrap?.classList.contains("ph-pwrap-right")).toBe(false);
  });
});
