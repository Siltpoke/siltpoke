/**
 * arch-toggle-regenerate-confirm-modal.acceptance.test.ts — ACCEPTANCE tests for the
 * duration-enhanced re-generate confirm modal on the arch-toggle-regenerate track.
 *
 * SCOPE — duration-enhanced confirm modal:
 *   Re-generate modal shows IN ONE SCREEN:
 *           generation age · duration · ≈$ estimate · replacement warning.
 *           grounded% removed from modal body per user decision — the header
 *           chip carries it; same-screen duplication eliminated.
 *           Example: "Generated 4h ago · 2m 14s" +
 *                    "Re-generating ≈$1.15 will replace it".
 *           Legacy caches (no durationMs) omit the duration segment gracefully —
 *           no "undefined", no dangling separator.
 *   Duration persistence contract (acceptance layer):
 *           seed generatedModel with durationMs → island modal shows "2m 14s" style
 *           duration on every open. The server write path is unit-covered in
 *           tests/explain/arch-cache-duration.test.ts — not duplicated here.
 *   The consequence line ("≈$X will replace it") is visible BEFORE
 *                 any confirm click; assert on OPEN modal's [data-modal-body].
 *
 * ACCEPTANCE BOUNDARY — outside-observable behavior only:
 *   • Island booted via mountRepoGraph() (same path as real page).
 *   • Assertions target [data-modal-body] textContent WHILE modal is open,
 *     BEFORE clicking any button.
 *   • No assertions on internal rendering details — unit-test territory.
 *
 * NON-DUPLICATION with unit tests
 * (tests/web/client/islands/repo-graph-duration-modal.test.ts, 9 tests):
 *   That file covers modal copy in the island-unit harness. This file boots the
 *   SAME island end-to-end via the acceptance harness (same conventions as
 *   sibling acceptance suites) and asserts the FULL "one-screen" compound: all
 *   four components visible together in a single modal-body probe, plus the
 *   cross-restart persistence contract.
 *
 * Anti-vacuous discipline:
 *   • Modal must be OPEN (non-null overlay) before probing body — verified with
 *     a hard expect before every body assertion.
 *   • Consequence line asserted on the OPEN modal BEFORE any confirm click.
 *   • No shared Response objects; each test installs its own fetch mock.
 *   • "undefined" / dangling separator absence guards paired with presence guards
 *     (age must still appear) to prevent vacuous passes.
 *   • grounded% must NOT appear in modal body.
 *
 * Run: bun test tests/acceptance/arch-toggle-regenerate-confirm-modal.acceptance.test.ts
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
  window.history.replaceState(null, "", "/repo-graph");
  document.querySelectorAll("[data-confirm-modal]").forEach((el) => el.remove());
  document.body.style.overflow = "";
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** One microtask tick — lets async IIFE continuations settle. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function getOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-confirm-modal]");
}

function modalBodyText(): string {
  return getOverlay()?.querySelector<HTMLElement>("[data-modal-body]")?.textContent ?? "";
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const EV = [{ file: "src/alpha/a.ts", line: 1 }];
const GEN_DOC = {
  boundary: "fixture-g",
  bands: [{ id: "core", label: { value: "GenBand", evidence: EV }, order: 0, members: ["genbox"] }],
  nodes: [
    {
      id: "genbox",
      kind: "cont",
      title: { value: "GenBox", evidence: EV },
      band: { value: "core", evidence: EV },
      drillTo: "alpha",
      members: ["src/alpha/a.ts"],
    },
  ],
  edges: [],
};

// Timestamps that produce predictable human-readable age strings.
const FOUR_HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
const TWENTYTHREE_MIN_AGO = new Date(Date.now() - 23 * 60 * 1000).toISOString();

// durationMs values mapped to expected formatted strings.
const DURATION_2M14S = 134_000; // 2 * 60 * 1000 + 14 * 1000
const DURATION_1M30S = 90_000; // 1m 30s (formatter: "${m}m ${sec}s", no zero-pad)

// ── Shared modal-open helper ──────────────────────────────────────────────────

/**
 * Boot the island, click re-generate, wait for the modal to settle.
 * Returns the opened overlay element.
 * Throws if the button is not found or the modal did not open.
 */
async function openModal(
  generatedModel: NonNullable<Parameters<typeof mountRepoGraph>[0]>["generatedModel"],
  estUsd: number | "fail" = 1.15,
): Promise<HTMLElement> {
  if (estUsd === "fail") {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.reject(new Error("network error"))],
    ]);
  } else {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd } }))],
    ]);
  }

  const root = await mountRepoGraph({ generatedModel });
  await tick();
  await tick();

  const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
  if (!genBtn) throw new Error("genBtn #rg-arch-gen not found in DOM — island did not boot");
  if (genBtn.hidden) throw new Error("genBtn is hidden — prerequisite not met");

  genBtn.click();
  await tick();
  await tick();

  const overlay = getOverlay();
  if (!overlay) throw new Error("[data-confirm-modal] not found — modal did not open");
  return overlay;
}

// ═══════════════════════════════════════════════════════════════════════════════
// One-screen compound: age · duration · consequence (grounded% NOT in body)
//
// grounded% removed from modal body (header chip carries it).
// Three content components must appear together; grounded% must be absent.
// ═══════════════════════════════════════════════════════════════════════════════

describe("full one-screen compound: age + duration + consequence, no grounded% (fresh cache)", () => {
  test("age + duration + consequence present in [data-modal-body]; grounded% absent", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 78,
      stale: false,
      generatedTs: FOUR_HOURS_AGO,
      durationMs: DURATION_2M14S,
    });

    // Anti-vacuous: confirm modal is still open, body element exists.
    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // ── Component 1: generation age ──
    // "4h ago" (exact token depends on formatter; "h ago" is the invariant).
    expect(body).toContain("4h ago");

    // ── Component 2: duration ──
    expect(body).toContain("took 2m 14s"); // "took" prefix labels the segment (user feedback)

    // ── grounded% must NOT be in modal body ──
    // Header chip (#rg-arch-chip) carries it; removing same-screen duplication.
    expect(body).not.toContain("grounded");

    // ── Component 3: consequence line ──
    // Assert on OPEN modal, BEFORE clicking anything.
    expect(body).toContain("≈$1.15");
    expect(body).toContain("will replace it");

    // Clean up.
    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("metadata line reads roughly 'Generated 4h ago · 2m 14s' in one body (no grounded%)", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 78,
      stale: false,
      generatedTs: FOUR_HOURS_AGO,
      durationMs: DURATION_2M14S,
    });

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // Metadata-line shape: age · duration in left-to-right order.
    // grounded% no longer in modal body.
    const ageIdx = body.indexOf("4h ago");
    const durIdx = body.indexOf("2m 14s");

    expect(ageIdx).toBeGreaterThanOrEqual(0);
    expect(durIdx).toBeGreaterThanOrEqual(0);
    expect(ageIdx).toBeLessThan(durIdx);

    // grounded% must not appear in modal body.
    expect(body).not.toContain("grounded");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

describe("one-screen compound: stale cache variant", () => {
  test("stale cache: age + duration + stale consequence line in [data-modal-body]; grounded% absent", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 62,
      stale: true,
      generatedTs: FOUR_HOURS_AGO,
      durationMs: DURATION_2M14S,
    });

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    expect(body).toContain("4h ago");
    expect(body).toContain("2m 14s");
    // grounded% must NOT be in modal body.
    expect(body).not.toContain("grounded");

    // Stale consequence line — must be visible before any confirm.
    expect(body).toContain("Code changed since last generation");
    expect(body).toContain("will replace it");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy cache (no durationMs): graceful omission
//
// Duration segment must be silently absent.
// "undefined" must not appear. "·" separator must not be left dangling.
// Age must still show (proof the rest of the line rendered).
// grounded% must NOT appear in modal body.
// ═══════════════════════════════════════════════════════════════════════════════

describe("legacy cache (no durationMs): graceful omission", () => {
  test("modal body does NOT contain 'undefined' when durationMs absent", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 65,
      stale: false,
      generatedTs: TWENTYTHREE_MIN_AGO,
      // durationMs intentionally absent
    });

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // No "undefined" string anywhere in body.
    expect(body).not.toContain("undefined");

    // ── No dangling "· ·" (double separator with blank or whitespace-only between).
    expect(body).not.toMatch(/·\s*·/);

    // Anti-vacuous presence guard: age still renders (modal not blank).
    expect(body).toContain("23m ago");
    // grounded% must NOT be in modal body.
    expect(body).not.toContain("grounded");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("legacy cache: age present without duration segment; grounded% absent from body", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 71,
      stale: false,
      generatedTs: TWENTYTHREE_MIN_AGO,
      // no durationMs
    });

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // Age must still show.
    expect(body).toContain("23m ago");
    // grounded% must NOT be in modal body.
    expect(body).not.toContain("grounded");
    // Duration-related strings must not appear from a null/undefined value.
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("NaNm");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("legacy stale cache: consequence line still shows without duration", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 55,
      stale: true,
      generatedTs: TWENTYTHREE_MIN_AGO,
      // no durationMs
    });

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // No undefined leak.
    expect(body).not.toContain("undefined");

    // Consequence line still present.
    expect(body).toContain("will replace it");

    // Age still present (anti-vacuous: modal not blank).
    expect(body).toContain("23m ago");
    // grounded% must NOT be in modal body.
    expect(body).not.toContain("grounded");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Duration persistence contract (acceptance layer)
//
// "survives restarts and shows on every future visit's modal" — at the acceptance
// layer this means: if the SSR payload includes durationMs (i.e., the server
// persisted it and hydrated it), the island modal shows it on every open, not
// just on the first open in a session.
//
// The server write path (Brain completion → meta.durationMs) is unit-covered in
// tests/explain/arch-cache-duration.test.ts. We do NOT duplicate those.
// ═══════════════════════════════════════════════════════════════════════════════

describe("persistence contract: seed durationMs → island shows it on every open", () => {
  test("first modal open after boot shows duration from seeded meta", async () => {
    const overlay = await openModal({
      doc: GEN_DOC,
      groundedPct: 80,
      stale: false,
      generatedTs: FOUR_HOURS_AGO,
      durationMs: DURATION_2M14S,
    });

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    // Duration must show on first open after boot (persistence read path).
    expect(bodyEl!.textContent ?? "").toContain("2m 14s");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("second modal open (cancel → re-open) still shows duration (no one-shot clear)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 80,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: DURATION_1M30S,
      },
    });
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn!.hidden).toBe(false);

    // ── First open ──
    genBtn!.click();
    await tick();
    await tick();

    const overlay1 = getOverlay();
    expect(overlay1).not.toBeNull();

    const body1 = overlay1!.querySelector<HTMLElement>("[data-modal-body]")?.textContent ?? "";
    // Formatter: "${m}m ${sec}s" with no zero-padding — 90s → "1m 30s".
    expect(body1).toContain("1m 30s");

    // Cancel.
    overlay1!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();

    // Modal gone.
    expect(getOverlay()).toBeNull();

    // ── Second open (simulates re-open after cancel — "every future visit") ──
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    genBtn!.click();
    await tick();
    await tick();

    const overlay2 = getOverlay();
    expect(overlay2).not.toBeNull();

    const body2 = overlay2!.querySelector<HTMLElement>("[data-modal-body]")?.textContent ?? "";
    // Duration still present on second open — not cleared after cancel.
    expect(body2).toContain("1m 30s");

    overlay2!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Consequence line visible BEFORE confirm click (all variants)
//
// This is a hard requirement:
// "the consequence line ('≈$X will replace it') is visible BEFORE confirm".
// Each variant gets a dedicated assertion on the OPEN modal before any click.
// ═══════════════════════════════════════════════════════════════════════════════

describe("consequence line visible in OPEN modal, BEFORE confirm click", () => {
  test("fresh cache: '≈$X will replace it' visible before any click", async () => {
    const overlay = await openModal(
      {
        doc: GEN_DOC,
        groundedPct: 80,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: DURATION_2M14S,
      },
      1.15,
    );

    // Anti-vacuous: modal is open.
    expect(overlay).not.toBeNull();

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // Consequence line (pre-confirm).
    expect(body).toContain("≈$1.15");
    expect(body).toContain("will replace it");

    // NOTE: we do NOT click confirm. The assertion is on the open modal.
    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("stale cache: stale consequence line visible before any click", async () => {
    const overlay = await openModal(
      {
        doc: GEN_DOC,
        groundedPct: 77,
        stale: true,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: DURATION_2M14S,
      },
      0.95,
    );

    expect(overlay).not.toBeNull();

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // Stale consequence line visible pre-confirm.
    expect(body).toContain("Code changed since last generation");
    expect(body).toContain("will replace it");
    expect(body).toContain("≈$0.95");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("estimate unavailable: 'Re-generating will replace it (estimate unavailable)' visible before any click", async () => {
    const overlay = await openModal(
      {
        doc: GEN_DOC,
        groundedPct: 80,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: DURATION_2M14S,
      },
      "fail",
    );

    expect(overlay).not.toBeNull();

    const bodyEl = overlay.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl).not.toBeNull();
    const body = bodyEl!.textContent ?? "";

    // Estimate-unavailable consequence line.
    expect(body).toContain("Re-generating will replace it");
    expect(body).toContain("estimate unavailable");

    overlay.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});
