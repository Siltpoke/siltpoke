/**
 * Unified decision modal: metadata line (age · duration) + consequence
 * line. Grounded% is deliberately NOT in the modal body — the header chip
 * carries it on-screen (a later revision of the original design).
 *
 * ── What is tested ────────────────────────────────────────────────────────────
 *
 *  1. Modal body contains the metadata line WITH duration when payload has
 *     durationMs (e.g. "Generated 4h ago · 2m 14s").
 *  2. Modal body contains the metadata line WITHOUT duration segment when
 *     durationMs is absent (legacy caches) — no "undefined", no dangling "·".
 *  3. Modal body does NOT contain grounded% (header chip carries it; no duplication).
 *  4. Consequence line present in BOTH fresh and stale copies BEFORE any confirm
 *     click (assert on the OPEN modal's [data-modal-body] textContent).
 *     - fresh: "Re-generating ≈$X will replace it."
 *     - stale: "Code changed since last generation — re-generating ≈$X will
 *       replace it."
 *     - estimate-unavailable: "Re-generating will replace it (estimate unavailable)."
 *  5. Anti-vacuous: probes check on the OPEN modal's body BEFORE any confirm click.
 *
 * Run: bun test tests/web/client/islands/repo-graph-duration-modal.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
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
  document.querySelectorAll("[data-confirm-modal]").forEach((el) => el.remove());
  document.body.style.overflow = "";
});

// ── helpers ────────────────────────────────────────────────────────────────────

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function getOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-confirm-modal]");
}

function modalBodyText(): string {
  return getOverlay()?.querySelector<HTMLElement>("[data-modal-body]")?.textContent ?? "";
}

// ── shared doc fixture ────────────────────────────────────────────────────────

const EV = [{ file: "src/alpha/a.ts", line: 1 }];
const GEN_DOC = {
  boundary: "fixture-dur",
  bands: [{ id: "core", label: { value: "G", evidence: EV }, order: 0, members: ["genbox"] }],
  nodes: [{ id: "genbox", kind: "cont", title: { value: "GenBox", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "alpha", members: ["src/alpha/a.ts"] }],
  edges: [],
};

// A generatedTs ~4 hours ago so "4h ago" appears in the metadata line.
const FOUR_HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
// A generatedTs ~23 minutes ago.
const TWENTYTHREE_MIN_AGO = new Date(Date.now() - 23 * 60 * 1000).toISOString();

// ═════════════════════════════════════════════════════════════════════════════
// 1. Metadata line WITH durationMs — shows age · duration (grounded% NOT here)
// ═════════════════════════════════════════════════════════════════════════════

describe("modal metadata line — WITH durationMs", () => {
  test("modal body does NOT contain grounded% (header chip carries it)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 78,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: 134_000, // 2m 14s
      },
    });
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    genBtn!.click();
    await tick();
    await tick();

    // Modal must be open.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Anti-vacuous: prove the action (click) opened the modal before probing body.
    expect(overlay).not.toBeNull(); // double-check

    // Grounded% must NOT be in modal body.
    // Header chip (#rg-arch-chip) carries grounded%; same-screen duplication removed.
    expect(body).not.toContain("grounded");
    // Legacy meta without costUsd → no "cost $" segment (graceful omit, same as duration).
    expect(body).not.toContain("cost $");
    // Anti-vacuous: confirm age IS present (so modal didn't render blank).
    expect(body).toContain("4h ago");

    // Clean up.
    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("modal body contains duration segment when durationMs present (2m 14s)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 78,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: 134_000, // 2m 14s
        costUsd: 1.5811, // → "cost $1.58"
      },
    });
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    genBtn!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Duration "2m 14s" in body.
    // Pre-impl: no duration segment → FAIL.
    expect(body).toContain("took 2m 14s"); // "took" prefix labels the segment (user feedback)
    // Last run's REAL spend, labeled "cost" — distinct from the future "≈$" estimate
    // in the consequence line (user feedback: append cost after duration).
    expect(body).toContain("cost $1.58");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("modal body contains age segment (e.g. '4h ago')", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 78,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: 134_000,
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Age "4h ago" in body.
    expect(body).toContain("4h ago");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("cache generated <60s ago shows 'just now', not '1m ago'", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 78,
        stale: false,
        generatedTs: new Date(Date.now() - 5_000).toISOString(),
        durationMs: 134_000,
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Pre-fix: Math.max(1, 0) floor rendered "1m ago" → FAIL.
    expect(body).toContain("just now");
    expect(body).not.toContain("1m ago");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Metadata line WITHOUT durationMs — no "undefined", no dangling "·", no grounded%
// ═════════════════════════════════════════════════════════════════════════════

describe("modal metadata line — WITHOUT durationMs", () => {
  test("modal body does NOT contain 'undefined' when durationMs absent", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.85 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 65,
        stale: false,
        generatedTs: TWENTYTHREE_MIN_AGO,
        // no durationMs
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // "undefined" must not appear.
    // Pre-impl: naive template `· ${durationMs}ms` → "undefined" → FAIL.
    expect(body).not.toContain("undefined");

    // Also no empty "·  ·" (dangling separator with blank segment).
    // Checks for two consecutive separators or "· ·" with only whitespace between.
    expect(body).not.toMatch(/·\s+·/);

    // Grounded% must NOT be in modal body (header chip carries it).
    expect(body).not.toContain("grounded");
    // Anti-vacuous: age IS present so modal isn't blank.
    expect(body).toContain("23m ago");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("modal body still shows age without duration segment, no grounded% (legacy cache)", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.85 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 65,
        stale: false,
        generatedTs: TWENTYTHREE_MIN_AGO,
        // no durationMs
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Age present ("23m ago") even when no durationMs.
    expect(body).toContain("23m ago");
    // Grounded% must NOT be in modal body (header chip carries it).
    expect(body).not.toContain("grounded");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Consequence line — present BEFORE any confirm click
// ═════════════════════════════════════════════════════════════════════════════

describe("modal consequence line — visible in OPEN modal before confirm", () => {
  test("fresh cache: consequence line says 'Re-generating ≈$X will replace it.'", async () => {
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
        durationMs: 60_000,
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Consequence line for fresh cache must contain ≈$1.15 + "will replace".
    // Pre-impl: old copy has "existing diagram will be replaced" but not the new
    // consequence-line format → FAIL on new wording.
    expect(body).toContain("will replace it");
    // Must mention the cost estimate (from the estimate fetch).
    expect(body).toContain("≈$1.15");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("stale cache: consequence line says 'Code changed since last generation — re-generating ≈$X will replace it.'", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.15 } }))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 80,
        stale: true,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: 60_000,
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Stale consequence line must contain "Code changed".
    // Pre-impl: old copy says "Diagram is outdated" not "Code changed" → FAIL.
    expect(body).toContain("Code changed since last generation");
    expect(body).toContain("will replace it");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });

  test("estimate unavailable: consequence line says 'Re-generating will replace it (estimate unavailable).'", async () => {
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      // Estimate fails.
      ["/arch/estimate", () => Promise.reject(new Error("network error"))],
    ]);

    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 80,
        stale: false,
        generatedTs: FOUR_HOURS_AGO,
        durationMs: 60_000,
      },
    });
    await tick();
    await tick();

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")!.click();
    await tick();
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const body = modalBodyText();
    // Estimate-unavailable consequence line.
    // Pre-impl: old copy says just "estimate unavailable" not the consequence form → FAIL.
    expect(body).toContain("estimate unavailable");
    expect(body).toContain("Re-generating will replace it");

    overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await tick();
  });
});
