/**
 * arch-toggle-regenerate-cancel.acceptance.test.ts — ACCEPTANCE tests for
 * the cancel slot-swap + honest terminal of the arch-toggle-regenerate track.
 *
 * SCOPE — cancel slot-swap + honest terminal:
 *   While a generation runs, the button slot-swaps to elapsed+cancel
 *           affordance (`🔄 M:SS · ✕ Cancel`, whole button clickable, same slot);
 *           click cancels IMMEDIATELY via /arch/cancel — no confirm dialog.
 *   After cancel, button returns to normal Generate/Re-generate affordance
 *           plus a muted "Last run cancelled · <time>" note. Visually distinct from
 *           the error-styled failed label. Spinner NEVER persists past terminal.
 *   Contingency cancel-races-done — cancel clicked, poll returns done → model loads,
 *           NO "Last run cancelled" note.
 *   Contingency cancel-POST-fails — cancel POST returns 404/error → polling continues
 *           honestly, run is not surfaced as cancelled.
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Island booted via mountRepoGraph() (SSR → registerRepoGraph → factory →
 *     init; same path as real page, no Alpine pipeline).
 *   • Running state seeded by: boot with no cache (task/null at reconnect) →
 *     click → generate POST resolves with taskId → poll stays pending (deferred).
 *   • Assertions target: button enabled/disabled state, label textContent,
 *     genCost textContent, CSS class presence/absence, spinner element existence,
 *     modal presence/absence, fetch POST counts.
 *   • No assertions on internal C4 node content — unit-test territory.
 *
 * NON-DUPLICATION with unit tests
 * (tests/web/client/islands/repo-graph-cancel.test.ts, 11 tests):
 *   That file covers individual internal transitions in the island factory with
 *   targeted deferred fetch mocks per component. This file boots the island
 *   end-to-end via the acceptance harness and asserts
 *   each behavior at the user-observable level: button affordance, genCost note,
 *   spinner absence, modal absence, and the regression pair (cancelled≠failed).
 *   No duplication of internal-state or tick-guard coverage.
 *
 * Anti-vacuous discipline:
 *   • BEFORE state verified before every click so changes are attributable.
 *   • Fetch spy positive-control counts (generate POST count verified ≥1 before
 *     asserting cancel POST count, ruling out "spy never installed" false zero).
 *   • "Absence" assertions paired with presence guards (element in DOM + prior
 *     state confirmed before transition).
 *   • No shared Response objects; each test installs its own fetch mock.
 *   • Running state confirmed (label contains "Cancel") before clicking cancel,
 *     ruling out vacuous absence-of-spinner on a never-started run.
 *
 * Run: bun test tests/acceptance/arch-toggle-regenerate-cancel.acceptance.test.ts
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
  window.history.replaceState(null, "", "/repo-graph");
  document.querySelectorAll("[data-confirm-modal]").forEach((el) => el.remove());
  document.body.style.overflow = "";
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** One microtask tick — lets async IIFE continuations settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Get #rg-arch-gen — the button that is the cancel affordance while running. */
function genBtnEl(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>("#rg-arch-gen");
}

/** Get #rg-arch-gen-label — the text slot inside the button. */
function genLabelEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("#rg-arch-gen-label");
}

/** Get #rg-arch-gen-cost — the muted hint / cost span below the button. */
function genCostEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("#rg-arch-gen-cost");
}

/** Shared generated-model doc for the races-done scenario. */
const GEN_DOC = {
  boundary: "fixture-h",
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
      title: { value: "GenBox", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
      band: { value: "core", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
      drillTo: "alpha",
      members: ["src/alpha/a.ts"],
    },
  ],
  edges: [],
};

// ── Shared boot helper ────────────────────────────────────────────────────────

/**
 * Boot island with no cache (task=null reconnect), click generate, wait for
 * the running state to settle. Returns { root, genBtn, genLabel, pollRunning }
 * where pollRunning is a deferred Response that keeps the poll suspended.
 *
 * The running state is confirmed by the caller checking that genLabel
 * contains "Cancel" — the running-state slot-swap — before proceeding.
 */
async function bootAndStartGenerate(
  cancelHandler: () => Promise<Response> = () =>
    Promise.resolve(
      jsonResponse({ success: true, data: { cancelledTaskId: "t-fixture-1" } }),
    ),
): Promise<{
  root: HTMLElement;
  genBtn: HTMLButtonElement;
  genLabel: HTMLElement;
  genCost: HTMLElement | null;
  pollRunning: ReturnType<typeof deferred<Response>>;
  generateCallCount: () => number;
}> {
  const pollRunning = deferred<Response>();
  let taskCalls = 0;
  let generateCalls = 0;

  installFetchMock([
    [
      "/arch/task",
      () => {
        taskCalls += 1;
        if (taskCalls === 1) {
          // Reconnect check at boot — no active task.
          return Promise.resolve(jsonResponse({ data: { task: null } }));
        }
        // Subsequent polls: keep the run alive (deferred).
        return pollRunning.promise;
      },
    ],
    [
      "/arch/generate",
      () => {
        generateCalls += 1;
        return Promise.resolve(
          jsonResponse({ success: true, taskId: "t-fixture-1" }),
        );
      },
    ],
    ["/arch/cancel", cancelHandler],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.12 } }))],
  ]);

  const root = await mountRepoGraph(); // no cache → no modal gate
  await tick();

  const genBtn = genBtnEl(root);
  if (!genBtn) throw new Error("#rg-arch-gen not found — island did not boot");

  // BEFORE state: button exists and is not running yet.
  expect(genBtn.disabled).toBe(false);

  // Click to start generate.
  genBtn.click();
  await tick();
  await tick(); // generate POST resolves → observeArchRun starts

  const genLabel = genLabelEl(root);
  const genCost = genCostEl(root);

  if (!genLabel) throw new Error("#rg-arch-gen-label not found");

  return {
    root,
    genBtn,
    genLabel,
    genCost,
    pollRunning,
    generateCallCount: () => generateCalls,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Running state slot-swap: button enabled + "Cancel" label + no modal
// ═══════════════════════════════════════════════════════════════════════════════

describe("running state: button ENABLED + label contains 'Cancel'", () => {
  test("genBtn is ENABLED (not disabled) while a generate is running", async () => {
    const { genBtn, genLabel, pollRunning } = await bootAndStartGenerate();

    // ── Positive control: confirm we are in running state (label changed).
    // This rules out "the generate never started and we're testing a never-disabled button".
    // The label must contain "Cancel" (the slot-swap) OR the elapsed M:SS pattern.
    // Either is evidence the observeArchRun tick() fired.
    const labelText = genLabel.textContent ?? "";
    const isRunningState = labelText.includes("Cancel") || /\d:\d\d/.test(labelText);
    expect(isRunningState).toBe(true);

    // ── Core: button MUST be ENABLED while running.
    // Pre-impl: observeArchRun set genBtn.disabled = true while running → FAIL.
    // Post-impl: button stays enabled to serve as cancel affordance.
    expect(genBtn.disabled).toBe(false);

    // Settle.
    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-fixture-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();
  });

  test("genBtn label contains 'Cancel' while running (slot-swap)", async () => {
    const { genLabel, pollRunning } = await bootAndStartGenerate();

    // ── Core: label must contain "Cancel" — the whole-button slot-swap.
    // Pre-impl: label showed "Generating… M:SS · usually ~2-3 min" with no Cancel → FAIL.
    expect(genLabel.textContent ?? "").toContain("Cancel");

    // Also: no confirm dialog was opened by clicking the button (cancel is immediate).
    expect(document.querySelector("[data-confirm-modal]")).toBeNull();

    // Settle.
    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-fixture-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Click while running: exactly 1 cancel POST, 0 generate POSTs, no modal
// ═══════════════════════════════════════════════════════════════════════════════

describe("click while running fires cancel POST immediately, no confirm dialog", () => {
  test("click cancel: exactly one /arch/cancel POST, zero extra /arch/generate POSTs, no modal", async () => {
    let cancelCalls = 0;
    const pollRunning = deferred<Response>();
    let taskCalls = 0;
    let generateCalls = 0;

    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          if (taskCalls === 1) return Promise.resolve(jsonResponse({ data: { task: null } }));
          return pollRunning.promise;
        },
      ],
      [
        "/arch/generate",
        () => {
          generateCalls += 1;
          return Promise.resolve(
            jsonResponse({ success: true, taskId: "t-cancel-post-1" }),
          );
        },
      ],
      [
        "/arch/cancel",
        () => {
          cancelCalls += 1;
          return Promise.resolve(
            jsonResponse({ success: true, data: { cancelledTaskId: "t-cancel-post-1" } }),
          );
        },
      ],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
    ]);

    const root = await mountRepoGraph();
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();

    // Start generate.
    genBtn!.click();
    await tick();
    await tick();

    // ── Positive control: one generate POST fired.
    expect(generateCalls).toBe(1);

    // Confirm running state (label has "Cancel").
    const labelText = genLabelEl(root)?.textContent ?? "";
    expect(labelText).toContain("Cancel");

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    // ── Core: click while running → cancel POST fires immediately.
    // Pre-impl: `if (generating) return;` was a no-op → cancelCalls = 0 → FAIL.
    genBtn!.click();
    await tick();

    expect(cancelCalls).toBe(1);

    // No second generate POST.
    expect(generateCalls).toBe(1);

    // No confirm modal opened (cancel is immediate, no modal gate).
    expect(document.querySelector("[data-confirm-modal]")).toBeNull();

    // Settle.
    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-cancel-post-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cancelled terminal: affordance restored + muted note (not error-red)
// ═══════════════════════════════════════════════════════════════════════════════

describe("cancelled terminal: normal button affordance restored", () => {
  test("after cancel terminal, button label is normal Generate/Re-generate (not error label)", async () => {
    const { genBtn, genLabel, pollRunning } = await bootAndStartGenerate();

    // BEFORE: confirm running state.
    expect(genLabel.textContent ?? "").toContain("Cancel");
    expect(genBtn.disabled).toBe(false);

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    // Click cancel.
    genBtn.click();
    await tick();

    // Resolve poll with cancelled terminal.
    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-fixture-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();

    // ── Core: button label must be a normal affordance, NOT "cancelled — retry".
    // Pre-impl: archTerminalLabel("cancelled") → "Generate cancelled — retry" → FAIL.
    const labelAfter = genLabel.textContent ?? "";
    expect(labelAfter).not.toContain("cancelled — retry");

    // Correct: normal affordance (Generate architecture OR Re-generate).
    const isNormalLabel =
      labelAfter.includes("Generate architecture") ||
      labelAfter.includes("Re-generate");
    expect(isNormalLabel).toBe(true);

    // Button must not be disabled after terminal.
    expect(genBtn.disabled).toBe(false);
  });

  test("cancelled terminal: genCost contains 'Last run cancelled' muted note", async () => {
    const { genBtn, genLabel, genCost, pollRunning } = await bootAndStartGenerate();

    // BEFORE: confirm running.
    expect(genLabel.textContent ?? "").toContain("Cancel");

    // Anti-vacuous: genCost element exists.
    expect(genCost).not.toBeNull();

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    genBtn.click();
    await tick();

    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-fixture-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();

    // ── Core: genCost must contain "Last run cancelled".
    // Pre-impl: finishUI() routed cancelled through archTerminalError → error-label path;
    // genCost stayed empty → FAIL.
    // Post-impl: cancelled branch writes muted note directly into genCost.
    expect(genCost!.textContent).toContain("Last run cancelled");
  });

  test("cancelled terminal: NO error-red styling classes on genBtn", async () => {
    const { genBtn, genLabel, pollRunning } = await bootAndStartGenerate();

    // BEFORE: confirm running.
    expect(genLabel.textContent ?? "").toContain("Cancel");

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    genBtn.click();
    await tick();

    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-fixture-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();

    // ── Core: no error-signaling CSS class on the button.
    // Cancelled is a user-choice, not a system error — must not style like one.
    expect(genBtn.classList.contains("arch-gen-error")).toBe(false);
    expect(genBtn.classList.contains("error")).toBe(false);
  });

  test("cancelled terminal: NO 🔄 spinner remnant anywhere in genLabel", async () => {
    const { genBtn, genLabel, pollRunning, root } = await bootAndStartGenerate();

    // BEFORE: confirm running state shows the spinner+Cancel label.
    expect(genLabel.textContent ?? "").toContain("Cancel");

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    genBtn.click();
    await tick();

    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-fixture-1",
            kind: "arch_generate",
            status: "cancelled",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();

    // ── Core: no .spin element left inside the label after terminal.
    // Pre-impl: tick() wrote innerHTML with <span class="spin"> during running;
    // the cancelled path might call updateArchAffordance() which sets textContent
    // on the wrapper — clearing the inner HTML — but only IF it targets the right
    // element. This test proves no .spin span survives past terminal.
    const spinEl = root.querySelector<HTMLElement>("#rg-arch-gen-label .spin");
    expect(spinEl).toBeNull();

    // Belt: the label text itself must not contain the 🔄 emoji (textContent guard).
    const labelText = genLabel.textContent ?? "";
    expect(labelText).not.toContain("🔄");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression — Failed terminal: error label renders (cancelled ≠ failed)
//
// Regression pair: proves the cancelled-path change did NOT accidentally route
// ALL terminal statuses through the new "muted note" path. Failed must still
// render the error label.
// ═══════════════════════════════════════════════════════════════════════════════

describe("regression: failed terminal keeps error label", () => {
  test("failed terminal: genLabel shows error text, NOT 'Last run cancelled' in genCost", async () => {
    const pollRunning = deferred<Response>();
    let taskCalls = 0;

    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          if (taskCalls === 1) return Promise.resolve(jsonResponse({ data: { task: null } }));
          return pollRunning.promise;
        },
      ],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "t-failed-distinct-1" })),
      ],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
    ]);

    const root = await mountRepoGraph();
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();

    // Start generate.
    genBtn!.click();
    await tick();
    await tick();

    // Confirm running state before resolving.
    const genLabel = genLabelEl(root);
    const labelDuringRun = genLabel?.textContent ?? "";
    const isRunningState = labelDuringRun.includes("Cancel") || /\d:\d\d/.test(labelDuringRun);
    expect(isRunningState).toBe(true);

    // Resolve poll with FAILED terminal (not cancelled).
    pollRunning.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-failed-distinct-1",
            kind: "arch_generate",
            status: "failed",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();

    // ── Regression: failed → error label in genLabel.
    const labelAfter = genLabel?.textContent ?? "";
    expect(labelAfter).toContain("failed");

    // ── Regression pair: genCost must NOT contain "Last run cancelled" for a failed run.
    const genCost = genCostEl(root);
    expect(genCost?.textContent ?? "").not.toContain("Last run cancelled");

    // And genLabel must not look like the normal affordance (regression proof).
    const isNormalLabel =
      labelAfter.includes("Generate architecture") ||
      (labelAfter === "↻ Re-generate");
    expect(isNormalLabel).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contingency — cancel-races-done: poll returns "done" after cancel click
//
// The registry's terminal state wins; "done" renders as a normal successful load.
// No "Last run cancelled" note must appear when done wins.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Contingency — cancel races done: done wins, NO 'Last run cancelled' note", () => {
  test("cancel clicked but poll returns done → model loads, genCost NOT 'Last run cancelled'", async () => {
    const pollDeferred = deferred<Response>();
    let taskCalls = 0;
    let cancelCalls = 0;

    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          if (taskCalls === 1) return Promise.resolve(jsonResponse({ data: { task: null } }));
          return pollDeferred.promise;
        },
      ],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "t-races-done-h-1" })),
      ],
      [
        "/arch/cancel",
        () => {
          cancelCalls += 1;
          // Cancel fires but the task already completed on the server.
          return Promise.resolve(
            jsonResponse({ success: false, error: "no_active_task" }),
          );
        },
      ],
      [
        "/arch/model",
        () =>
          Promise.resolve(
            jsonResponse({
              data: {
                model: GEN_DOC,
                groundedPct: 82,
                fileFunctions: null,
                generatedTs: new Date().toISOString(),
                durationMs: 38000,
              },
            }),
          ),
      ],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
    ]);

    const root = await mountRepoGraph();
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();

    // Start generate.
    genBtn!.click();
    await tick();
    await tick();

    // Confirm running state.
    const genLabel = genLabelEl(root);
    const labelDuringRun = genLabel?.textContent ?? "";
    const isRunningState = labelDuringRun.includes("Cancel") || /\d:\d\d/.test(labelDuringRun);
    expect(isRunningState).toBe(true);

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    // Click cancel (fires cancel POST) — but simultaneously resolve poll with "done".
    genBtn!.click();

    // Resolve poll with "done" — done wins.
    pollDeferred.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-races-done-h-1",
            kind: "arch_generate",
            status: "done",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();
    await tick();

    // ── Contingency core: "done" wins → genCost must NOT contain "Last run cancelled".
    const genCost = genCostEl(root);
    expect(genCost?.textContent ?? "").not.toContain("Last run cancelled");

    // ── Positive control: cancel POST was actually fired (proves we exercised the right path).
    // cancelCalls ≥ 1 means the button click reached the cancel branch.
    expect(cancelCalls).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Contingency — cancel POST fails (404/network): run continues honestly
//
// When the cancel POST itself fails, the run keeps polling. The island must not
// crash; the button must still be in the DOM.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Contingency — cancel POST 404: run continues, no crash", () => {
  test("cancel endpoint 404 → island stays mounted, polling continues without error state", async () => {
    const pollDone = deferred<Response>();
    let taskCalls = 0;
    let cancelCalls = 0;

    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          if (taskCalls === 1) return Promise.resolve(jsonResponse({ data: { task: null } }));
          // All subsequent polls: keep running (deferred).
          return pollDone.promise;
        },
      ],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "t-cancel-404-h-1" })),
      ],
      [
        "/arch/cancel",
        () => {
          cancelCalls += 1;
          // 404 — route not found or task already gone.
          return Promise.resolve(
            new Response(
              JSON.stringify({ success: false, error: "no_active_task" }),
              { status: 404 },
            ),
          );
        },
      ],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
    ]);

    const root = await mountRepoGraph();
    await tick();

    const genBtn = genBtnEl(root);
    expect(genBtn).not.toBeNull();

    // Start generate.
    genBtn!.click();
    await tick();
    await tick();

    // Confirm running state.
    const genLabel = genLabelEl(root);
    const labelDuringRun = genLabel?.textContent ?? "";
    const isRunningState = labelDuringRun.includes("Cancel") || /\d:\d\d/.test(labelDuringRun);
    expect(isRunningState).toBe(true);

    // Pass the 600ms cancel arm window (double-click guard) before clicking cancel.
    await new Promise((r) => setTimeout(r, 650)); // pass the 600ms cancel arm window (double-click guard)

    // Click cancel — cancel POST returns 404.
    genBtn!.click();
    await tick();
    await tick();

    // ── Contingency core: no crash, island still mounted.
    // Pre-impl: unhandled 404 from cancel might throw → island unmounts → FAIL.
    expect(root.querySelector("#rg-arch-gen")).not.toBeNull();

    // ── Positive control: cancel POST was fired (not silently swallowed before reaching fetch).
    expect(cancelCalls).toBeGreaterThanOrEqual(1);

    // ── The run must continue (not surface cancelled state) — genCost must NOT show cancelled note.
    // (The poll is still in-flight; genCost is empty or shows the cost estimate, not cancelled.)
    const genCost = genCostEl(root);
    expect(genCost?.textContent ?? "").not.toContain("Last run cancelled");

    // Settle with a done terminal.
    pollDone.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-cancel-404-h-1",
            kind: "arch_generate",
            status: "done",
            repo: "f1x7ur3hash0",
            startedTs: new Date().toISOString(),
            startedAgoMs: 100,
          },
        },
      }),
    );
    await tick();
    await tick();
  });
});
