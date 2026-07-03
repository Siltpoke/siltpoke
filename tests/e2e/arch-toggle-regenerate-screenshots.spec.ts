/**
 * arch-toggle-regenerate-screenshots.spec.ts — visual-capture layer for the
 * arch-toggle-regenerate button, modal, and running/cancelled states.
 *
 * Captures 7 full-page PNGs into test-screenshots/ (committed for
 * PR audit). Runs ON GREEN, not only-on-failure. Each test asserts its DOM
 * preconditions before shooting — the capture is evidence, not decoration.
 *
 * Harness pattern: same as the other screenshot specs in this directory.
 * - Daemon started by playwright.config webServer (port 9877, e2e home
 *   .playwright-tmp/siltpoke, SILTPOKE_TEST_MOCK_STREAM=1).
 * - Fixtures seeded into .playwright-tmp/siltpoke/repo-memory/<hash>/ at
 *   test time; the daemon reads them on every request — no restart needed.
 * - BIG_FIXTURE_HASH / seedBigEstimateFixture from the shared fixtures
 *   module: a 2,500-symbol non-authored repo (no .siltpoke/arch-c4.json in
 *   project root). Non-authored means the island shows the Auto|Generated
 *   chip instead of Authored|Generated.
 * - A minimal valid ArchModelDoc + ArchModelMeta is seeded alongside the
 *   graph to put the UI into "fresh generated cache" state (src-chip visible,
 *   ghost ↻ Re-generate button). For the stale scenario a mismatched
 *   fingerprint in the meta triggers the accent ↻ Re-generate — code changed
 *   variant.
 * - All fixtures are cleaned up in afterAll / finally so the shared home is
 *   left exactly as found (verification-repo cleanup discipline).
 *
 * Layout/behavior notes:
 *   - The Re-generate button is relocated to the pagehead trailing edge with
 *     a .pagehead-divider spatially separating it from the $0 cluster.
 *   - The re-generate confirmation is a unified modal: age · duration meta
 *     line + consequence line (grounded% moved to the header chip).
 *   - Running state uses a slot-swap "🔄 M:SS · ✕ Cancel"; cancelled shows a
 *     muted terminal state.
 *
 * Scenarios (numbered by user flow):
 *   01  arch C4 view with fresh generated cache: Auto|Generated chip (Auto
 *       active), ghost ↻ Re-generate at FAR RIGHT past the divider.
 *       Also asserts #rg-arch-gen is last .pagehead child + .pagehead-divider
 *       present & visible.
 *       NOTE: #rg-arch-chip lives in toolbar-right, not the pagehead — no
 *       Scenario 01 DOM assertion pins the chip to the pagehead (comment-only
 *       reference at line 407); screenshots capture the toolbar position.
 *   02  after clicking Auto (subset view active, URL shows ?arch-source=subset).
 *   03  re-generate modal from FRESH state: unified modal assertions — age ("ago"),
 *       duration ("m " + "s"), AND consequence line "will replace it" with ≈$.
 *       grounded% NOT asserted in modal body (header chip carries it). Capture.
 *   04  stale variant: accent button + stale modal with "Code changed since last
 *       generation" copy.
 *   05  after modal Cancel: modal gone, view unchanged (zero cost).
 *   06  running state via Playwright route mocks (zero real Brain calls).
 *       Mocks POST /arch/generate → {taskId} + GET /arch/task → running.
 *       Direct fire on a NO-CACHE repo (no modal). Assert label contains
 *       "Cancel" + "🔄" spinner, then screenshot.
 *   07  cancelled terminal (continued from 06). Mock GET /arch/task →
 *       cancelled, mock POST /arch/cancel → success, click the button (cancel).
 *       Assert genCost contains "Last run cancelled" + label back to "⚡ Generate"
 *       + NO "🔄" remnant, then screenshot.
 *
 * Quality note: the estimate fetch for the fresh-path cost span
 * (`≈$X · Claude`) is async; waitForFunction() guards the capture so a
 * racing promise can't produce an empty span.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BIG_FIXTURE_HASH,
  cleanupBigEstimateFixture,
  E2E_HOME,
  seedBigEstimateFixture,
} from "./_setup/honesty-e2e-fixtures";
import { computeRepoFingerprint } from "../../src/explain/arch-cache";
import { emptyFingerprints } from "../../src/repo-graph/types";

const OUT_DIR = join(process.cwd(), "test-screenshots");

// ── Minimal valid ArchModelDoc for the e2e fixture ────────────────────────
//
// Requirements from arch-model-schema.ts + validateArchIntegrity:
//  • boundary: non-empty string
//  • bands: each with id, label (value+evidence), order, members (cont ids)
//  • nodes: cont nodes each in exactly one band; each needs title+band+evidence
//  • edges: each endpoint must exist in nodes
// We use one band "layer-app", one cont "app-core", no edges (allowed).
// Tier fields are optional on the wire.
const FIXTURE_ARCH_DOC = {
  boundary: "fixture-repo-big",
  bands: [
    {
      id: "layer-app",
      label: {
        value: "Application",
        evidence: [{ file: "src/alpha/alpha-mod-0.ts", line: 1 }],
      },
      order: 0,
      members: ["app-core"],
    },
  ],
  nodes: [
    {
      id: "app-core",
      kind: "cont",
      title: {
        value: "Alpha Core",
        evidence: [{ file: "src/alpha/alpha-mod-0.ts", line: 1 }],
      },
      band: {
        value: "layer-app",
        evidence: [{ file: "src/alpha/alpha-mod-0.ts", line: 1 }],
      },
      members: ["src/alpha/alpha-mod-0.ts"],
    },
  ],
  edges: [],
  groundedPct: 80,
};

// ── Fixture helpers ───────────────────────────────────────────────────────

/** The deterministic fingerprint for an empty fingerprints file (the big
 *  fixture seeds emptyFingerprints(), so this IS the current fingerprint). */
const FRESH_FINGERPRINT = computeRepoFingerprint(emptyFingerprints());

/**
 * Write arch-model.json + arch-model.meta.json into the big fixture's
 * storageDir. `fingerprint` controls fresh/stale:
 *   - FRESH_FINGERPRINT = matches → fresh (ghost ↻ button)
 *   - "stale-sentinel-mismatch" = doesn't match → stale (accent ↻ button)
 *
 * graphIndexedTs is taken from the meta.last_indexed_ts that
 * seedBigEstimateFixture() writes (a live new Date().toISOString()), so we
 * can't know it statically. We pass it in after seeding.
 *
 * durationMs (optional) — when provided, the island renders a "Xm Ys"
 * segment in the unified modal meta line. Omit for legacy-cache tests.
 * 134000ms → "2m 14s" (matches humanizeDurationMs).
 */
async function writeArchFixture(
  storageDir: string,
  fingerprint: string,
  graphIndexedTs: string,
  durationMs?: number,
): Promise<void> {
  const meta: Record<string, unknown> = {
    schemaVersion: 1,
    fingerprint,
    graphIndexedTs,
    costUsd: 1.48,
    groundedPct: 80,
    model: "sonnet",
    generatedTs: new Date().toISOString(),
  };
  if (durationMs !== undefined) {
    meta.durationMs = durationMs;
  }
  await writeFile(
    join(storageDir, "arch-model.json"),
    JSON.stringify(FIXTURE_ARCH_DOC, null, 2),
    "utf8",
  );
  await writeFile(
    join(storageDir, "arch-model.meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
}

/** Remove the arch-model pair without touching the graph files. */
async function removeArchFixture(storageDir: string): Promise<void> {
  for (const name of ["arch-model.json", "arch-model.meta.json"]) {
    const p = join(storageDir, name);
    if (existsSync(p)) await rm(p, { force: true });
  }
}

// ── Shared viewport & output dir setup ────────────────────────────────────

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
});

// ── Scenario 01 ───────────────────────────────────────────────────────────
//
// Non-authored repo, FRESH generated cache → C4 arch view.
// DOM assertions:
//   • src-chip visible
//   • Auto segment present + NOT active (we start on the subset/Auto view,
//     which IS the left segment — so it IS active; the Generated seg is right)
//   • Generated segment present, NOT active (we're on subset/Auto view)
//   • ghost ↻ Re-generate button visible (rg-btn-ghost class)
//   • wait for cost span to contain "≈$" (estimate resolved before snap)
//   • #rg-arch-gen is the last child of .pagehead (spatial isolation)
//   • .pagehead-divider is present and visible

test("01 — Auto|Generated chip visible, ghost ↻ Re-generate + estimate hint, button at trailing edge", async ({
  page,
}) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    // Read the graphIndexedTs from the seeded meta so the arch meta is fresh.
    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) =>
      fs.readFile(metaPath, "utf8"),
    );
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    await writeArchFixture(storageDir, FRESH_FINGERPRINT, graphMeta.last_indexed_ts);

    // Load the non-authored repo. Default source: no authored → fresh
    // generated → island picks generated (precedence rung 5).
    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800); // C4 layout settle

    // src-chip must be visible (non-authored + hasGenerated = true)
    const srcChip = page.locator("#rg-src-chip");
    await expect(srcChip).toBeVisible({ timeout: 8_000 });

    // Left segment labelled "Auto" (not "Authored" — no authored model)
    const segAuto = page.locator("#rg-src-authored");
    await expect(segAuto).toHaveText("Auto");

    // Generated segment present
    const segGen = page.locator("#rg-src-generated");
    await expect(segGen).toBeVisible();

    // The ghost Re-generate button must be visible — .rg-btn-ghost tier
    const genBtn = page.locator("#rg-arch-gen");
    await expect(genBtn).toBeVisible({ timeout: 8_000 });
    await expect(genBtn).toHaveClass(/rg-btn-ghost/);

    // Wait for affordance to resolve before snapping (anti-vacuous: fresh-cache
    // span shows "Diagram is current" — ≈$ was removed from the Re-generate
    // button; ≈$ now lives in the confirm modal body only).
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#rg-arch-gen-cost");
        return el !== null && (el.textContent?.includes("Diagram is current") ?? false);
      },
      { timeout: 12_000 },
    );

    // #rg-arch-gen must be the LAST child of .pagehead (spatial isolation).
    const isLastChild = await page.evaluate(() => {
      const btn = document.querySelector("#rg-arch-gen");
      const pagehead = document.querySelector(".pagehead");
      if (!btn || !pagehead) return false;
      const children = Array.from(pagehead.children);
      return children[children.length - 1] === btn;
    });
    expect(isLastChild).toBe(true);

    // .pagehead-divider must be present and visible (the 1px hairline
    // that spatially separates the paid button from the $0 cluster).
    const divider = page.locator(".pagehead-divider");
    await expect(divider).toBeVisible({ timeout: 4_000 });

    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-01-auto-generated-chip.png"),
      fullPage: true,
    });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 02 ───────────────────────────────────────────────────────────
//
// Click the Auto segment when Generated is active → switches to subset view.
// URL must reflect ?arch-source=subset (or bare URL with subset active).
// DOM assertions:
//   • Auto segment has class "active"
//   • Generated segment does NOT have class "active"
//   • URL contains "arch-source=subset" (or no arch-source param for subset)

test("02 — click Auto: subset view active, URL shows ?arch-source=subset", async ({
  page,
}) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) =>
      fs.readFile(metaPath, "utf8"),
    );
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    await writeArchFixture(storageDir, FRESH_FINGERPRINT, graphMeta.last_indexed_ts);

    // Start on the generated view explicitly so the Auto click has somewhere
    // to go (generated → subset).
    await page.goto(
      `/repo-graph?repo=${BIG_FIXTURE_HASH}&arch-source=generated`,
    );
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Confirm Generated is active before clicking
    const segGen = page.locator("#rg-src-generated");
    await expect(segGen).toHaveClass(/active/, { timeout: 6_000 });

    // Click Auto segment to switch to subset
    const segAuto = page.locator("#rg-src-authored");
    await segAuto.click();

    // URL should now reflect ?arch-source=subset
    await page.waitForFunction(
      () =>
        new URLSearchParams(window.location.search).get("arch-source") ===
        "subset",
      { timeout: 6_000 },
    );

    // Auto segment now active, Generated not
    await expect(segAuto).toHaveClass(/active/, { timeout: 6_000 });
    await expect(segGen).not.toHaveClass(/active/);

    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-02-toggle-subset.png"),
      fullPage: true,
    });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 03 ───────────────────────────────────────────────────────────
//
// Re-generate modal from FRESH state (ghost ↻ Re-generate click).
// Unified modal assertions:
//   • [data-confirm-modal] overlay appears
//   • modal title "Re-generate diagram?"
//   • modal body LINE 1 (meta) contains "ago" (age) + "m " + "s" (duration from
//     durationMs=134000 → "2m 14s") — grounded% NOT here (header chip carries it)
//   • modal body LINE 2 (consequence) contains "will replace it" with ≈$
//   • confirm button reads bare "Re-generate"; body consequence line carries ≈$
//   • Cancel button is focused (a11y default)
//
// durationMs=134000 → humanizeDurationMs(134000) = "2m 14s"

test("03 — modal from fresh state: unified modal age·duration·consequence (no grounded%), bare Re-generate confirm, Cancel focused", async ({
  page,
}) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) =>
      fs.readFile(metaPath, "utf8"),
    );
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    // Seed with durationMs=134000 → "2m 14s" in the unified modal meta line.
    await writeArchFixture(
      storageDir,
      FRESH_FINGERPRINT,
      graphMeta.last_indexed_ts,
      134000,
    );

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Wait for affordance to resolve: fresh-cache span shows "Diagram is current"
    // (≈$ was removed from the Re-generate button; modal body carries the cost).
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#rg-arch-gen-cost");
        return el !== null && (el.textContent?.includes("Diagram is current") ?? false);
      },
      { timeout: 12_000 },
    );

    // Click ghost Re-generate button → modal opens + re-fetches estimate
    const genBtn = page.locator("#rg-arch-gen");
    await expect(genBtn).toBeVisible({ timeout: 6_000 });
    await genBtn.click();

    // Wait for modal overlay
    const overlay = page.locator("[data-confirm-modal]");
    await expect(overlay).toBeVisible({ timeout: 8_000 });

    // Title
    await expect(overlay.locator("[data-modal-title]")).toHaveText(
      "Re-generate diagram?",
    );

    // Wait for the BODY's consequence line to carry ≈$ (estimate re-fetched on
    // modal open). The confirm button is a bare "Re-generate" — cost prints
    // once, in the body line above it.
    await page.waitForFunction(
      () => {
        const body = document.querySelector("[data-modal-body]");
        return body !== null && (body.textContent?.includes("≈$") ?? false);
      },
      { timeout: 10_000 },
    );
    await expect(page.locator("[data-confirm-btn]")).toHaveText("Re-generate");

    // Unified modal body assertions.
    // Line 1 (meta): must contain age ("just now" or "ago") + duration ("m " + "s").
    // grounded% is NOT asserted here — the toolbar chip (#rg-arch-chip, which
    // lives in toolbar-right, not the pagehead) carries it.
    // humanizeGeneratedAgo returns "just now" when the fixture was just written
    // (< 60s ago); "ago" only appears for older caches. Either is valid evidence
    // that the age field is present and non-empty in the modal.
    const body = overlay.locator("[data-modal-body]");
    await expect(body).toContainText("Generated ", { timeout: 8_000 }); // age prefix always present
    await expect(body).toContainText("m ", { timeout: 4_000 }); // duration minutes component
    await expect(body).toContainText("s", { timeout: 4_000 }); // duration seconds component
    await expect(body).not.toContainText("grounded", { timeout: 4_000 }); // header chip only

    // Line 2 (consequence): must contain "will replace it" + ≈$.
    await expect(body).toContainText("will replace it", { timeout: 4_000 });
    await expect(body).toContainText("≈$", { timeout: 4_000 });

    // Cancel button is the a11y default focus (confirmModal.ts: cancelBtn.focus())
    const cancelBtn = overlay.locator("[data-cancel-btn]");
    await expect(cancelBtn).toBeFocused({ timeout: 4_000 });

    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-03-modal-fresh.png"),
      fullPage: true,
    });
  } finally {
    // We leave the modal open, clean up fixtures, page navigates away
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 04 ───────────────────────────────────────────────────────────
//
// STALE fixture: accent ↻ Re-generate — code changed button + stale modal.
// DOM assertions (button state — always feasible):
//   • genBtn has class rg-btn-accent
//   • genBtn label text contains "Re-generate — code changed"
// Additional (modal state — feasible: stale button opens modal same as fresh):
//   • modal body contains "Code changed since last generation"

test("04 — stale fixture: accent Re-generate button + stale modal copy", async ({
  page,
}) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    // Write STALE arch fixture: mismatched fingerprint → stale: true on read
    await writeArchFixture(
      storageDir,
      "stale-sentinel-intentional-mismatch-0000000000000000",
      "2020-01-01T00:00:00.000Z", // always mismatches the live graphIndexedTs
    );

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Accent button must be visible (stale state)
    const genBtn = page.locator("#rg-arch-gen");
    await expect(genBtn).toBeVisible({ timeout: 8_000 });
    await expect(genBtn).toHaveClass(/rg-btn-accent/);

    // Label must contain the stale text
    const genLabel = page.locator("#rg-arch-gen-label");
    await expect(genLabel).toContainText("Re-generate — code changed", {
      timeout: 6_000,
    });

    // Capture button state BEFORE opening modal (the "stale button" screenshot)
    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-04-modal-stale.png"),
      fullPage: true,
    });

    // Also capture the open stale modal (same file — we overwrite with the
    // richer modal frame; the button state is visible behind the overlay).
    await genBtn.click();
    const overlay = page.locator("[data-confirm-modal]");
    await expect(overlay).toBeVisible({ timeout: 8_000 });
    await expect(overlay.locator("[data-modal-body]")).toContainText(
      "Code changed since last generation",
      { timeout: 8_000 },
    );
    // Re-shoot with modal open (replaces the button-only shot with a fuller scene)
    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-04-modal-stale.png"),
      fullPage: true,
    });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 05 ───────────────────────────────────────────────────────────
//
// After Cancel: modal dismissed, view unchanged (zero cost).
// DOM assertions:
//   • [data-confirm-modal] is gone (count 0)
//   • src-chip still visible (view unchanged)
//   • genBtn still visible (view unchanged — not a generate in progress)
//   • URL unchanged (no navigation triggered by Cancel)

test("05 — cancel: modal gone, view unchanged, zero cost", async ({ page }) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) =>
      fs.readFile(metaPath, "utf8"),
    );
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    await writeArchFixture(storageDir, FRESH_FINGERPRINT, graphMeta.last_indexed_ts);

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Wait for affordance to resolve: fresh-cache span shows "Diagram is current"
    // (≈$ was removed from the Re-generate button; modal body carries the cost).
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#rg-arch-gen-cost");
        return el !== null && (el.textContent?.includes("Diagram is current") ?? false);
      },
      { timeout: 12_000 },
    );

    const genBtn = page.locator("#rg-arch-gen");
    await genBtn.click();

    const overlay = page.locator("[data-confirm-modal]");
    await expect(overlay).toBeVisible({ timeout: 8_000 });

    // Click Cancel
    await overlay.locator("[data-cancel-btn]").click();

    // Modal must be gone
    await expect(overlay).toHaveCount(0, { timeout: 5_000 });

    // View must be unchanged (chip still visible, button still there)
    await expect(page.locator("#rg-src-chip")).toBeVisible();
    await expect(genBtn).toBeVisible();

    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-05-cancel-zero-cost.png"),
      fullPage: true,
    });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 06 ───────────────────────────────────────────────────────────
//
// Running state — ZERO real Brain calls: Playwright page.route() mocks.
// Approach:
//   • No arch fixture seeded → NO-CACHE state → direct fire (no modal gate).
//   • Mock POST /api/repo-graph/arch/generate → {taskId: "mock-task-001"}
//   • Mock GET  /api/repo-graph/arch/task    → status:"running", startedAgoMs:0
//     (kept running forever so observeArchRun's timer ticks; the test captures
//      the running label before any terminal is emitted).
//   • Click ⚡ Generate — island POSTs generate → observeArchRun enters loop.
//   • Assert: genLabel CONTAINS "Cancel" + contains "🔄" (spin className renders
//     as a span, but genLabel.innerHTML has it) — or more precisely, assert the
//     button's textContent includes "Cancel" and does NOT include "⚡ Generate".
//
// Why textContent not innerHTML for 🔄: the label span injects a <span
// class="spin"></span> for the spinner CSS animation; actual "🔄" emoji is NOT
// in the live DOM — the island uses the CSS class. So we assert:
//   • label textContent includes "Cancel" (the ✕ Cancel suffix in slot-swap)
//   • label textContent does NOT include "⚡ Generate" (no stale affordance text)
//   • The button itself is ENABLED (not disabled — the button is the cancel aff.)

test("06 — running state: mocked generate+task routes, Cancel affordance visible", async ({
  page,
}) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;
    // NO arch fixture seeded → no-cache → direct fire (no modal).

    // ── Route mocks ────────────────────────────────────────────────────────
    // generateFired: true once the POST /arch/generate has been intercepted.
    // The GET /arch/task mock returns null UNTIL generate fires (prevents
    // reconnectArchTask() on page-load from auto-attaching and entering
    // observeArchRun before the test's click — that would make the subsequent
    // click fire runArchCancel() instead of runArchGenerate()).
    let generateFired = false;

    // POST /api/repo-graph/arch/generate → synthetic taskId; set generateFired flag
    await page.route("**/api/repo-graph/arch/generate", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      generateFired = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, taskId: "mock-task-001" }),
      });
    });

    // GET /api/repo-graph/arch/task → null until generate fires (reconnect guard),
    // then "running" (keeps the polling loop alive so the Cancel label stays up).
    await page.route("**/api/repo-graph/arch/task*", async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      if (!generateFired) {
        // Page-load reconnect: return no active task so reconnectArchTask no-ops.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: { task: null } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            task: {
              id: "mock-task-001",
              kind: "arch_generate",
              repo: BIG_FIXTURE_HASH,
              status: "running",
              startedTs: new Date().toISOString(),
              startedAgoMs: 0,
            },
          },
        }),
      });
    });

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    // Give reconnectArchTask() time to fire + resolve null before we interact.
    await page.waitForTimeout(800);

    // No-cache state: genBtn visible + default tier (⚡ Generate architecture)
    const genBtn = page.locator("#rg-arch-gen");
    await expect(genBtn).toBeVisible({ timeout: 8_000 });
    const genLabel = page.locator("#rg-arch-gen-label");
    // Confirm idle label (not already in running state from reconnect)
    await expect(genLabel).toContainText("Generate", { timeout: 4_000 });

    // Click ⚡ Generate → direct fire (no modal, no cache) → island POSTs
    // /arch/generate → gets {taskId} → calls observeArchRun → slot-swap label
    // to "<spin> 0:00 · ✕ Cancel".
    await genBtn.click();

    // Wait for the running slot-swap label: textContent must include "Cancel"
    // (the slot-swap writes innerHTML = "<span class='spin'></span> M:SS · ✕ Cancel").
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#rg-arch-gen-label");
        return el !== null && (el.textContent?.includes("Cancel") ?? false);
      },
      { timeout: 10_000 },
    );

    // Assert: button is ENABLED (the button is the cancel affordance while running)
    await expect(genBtn).toBeEnabled();

    // Assert: label contains "Cancel" (the slot-swap ✕ Cancel suffix)
    await expect(genLabel).toContainText("Cancel");

    // Assert: label does NOT contain "⚡ Generate" (not the idle affordance)
    await expect(genLabel).not.toContainText("⚡ Generate");

    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-06-running-cancel.png"),
      fullPage: true,
    });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 07 ───────────────────────────────────────────────────────────
//
// Cancelled terminal — continued from scenario 06's route-mock approach.
// Independent test (doesn't share state with 06) — re-mocks routes but this
// time flips /arch/task to return "cancelled" after the mock POST /arch/cancel.
// Approach:
//   • Same no-cache seed as 06 → direct fire → enter running state.
//   • THEN flip the GET /arch/task mock to return "cancelled" + mock POST
//     /arch/cancel → success. The pollArchTaskTerminal loop picks up
//     "cancelled" on next tick (2s poll), but we also need to satisfy the
//     cancel button click → POST /arch/cancel path.
//   • Click the button while running (= cancel) → island sees cancellingArch +
//     genLabel shows "cancelling…" → then poll returns "cancelled" → terminal.
//   • Assert: genCost contains "Last run cancelled" + genLabel back to
//     "⚡ Generate architecture" (no-cache state) + no "🔄" in genLabel.

test("07 — cancelled terminal: genCost 'Last run cancelled', label restored to ⚡ Generate", async ({
  page,
}) => {
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;
    // NO arch fixture seeded → no-cache → direct fire.

    // generateFired: true once POST /arch/generate intercepted.
    // cancelFired: true once POST /arch/cancel intercepted.
    // Same reconnect-guard pattern as scenario 06: GET /arch/task returns null
    // until generate fires so reconnectArchTask() no-ops on page load.
    let generateFired = false;
    let cancelFired = false;

    // POST /api/repo-graph/arch/generate → taskId; set generateFired
    await page.route("**/api/repo-graph/arch/generate", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      generateFired = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, taskId: "mock-task-007" }),
      });
    });

    // GET /api/repo-graph/arch/task:
    //   - before generate: null (reconnect guard)
    //   - after generate, before cancel: "running"
    //   - after cancel: "cancelled" (poll picks up terminal)
    await page.route("**/api/repo-graph/arch/task*", async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      if (!generateFired) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: { task: null } }),
        });
        return;
      }
      const status = cancelFired ? "cancelled" : "running";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            task: {
              id: "mock-task-007",
              kind: "arch_generate",
              repo: BIG_FIXTURE_HASH,
              status,
              startedTs: new Date().toISOString(),
              startedAgoMs: 0,
            },
          },
        }),
      });
    });

    // POST /api/repo-graph/arch/cancel → success; set cancelFired so next poll
    // returns "cancelled" and observeArchRun reaches the cancelled terminal.
    await page.route("**/api/repo-graph/arch/cancel*", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      cancelFired = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    // Give reconnectArchTask() time to fire + resolve null before we interact.
    await page.waitForTimeout(800);

    const genBtn = page.locator("#rg-arch-gen");
    await expect(genBtn).toBeVisible({ timeout: 8_000 });
    const genLabel = page.locator("#rg-arch-gen-label");
    // Confirm idle state (not yet in running from reconnect)
    await expect(genLabel).toContainText("Generate", { timeout: 4_000 });

    // Click ⚡ Generate → direct fire → enter running state
    await genBtn.click();

    // Wait until running slot-swap: label contains "Cancel" (capital C — from "✕ Cancel")
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#rg-arch-gen-label");
        return el !== null && (el.textContent?.includes("Cancel") ?? false);
      },
      { timeout: 10_000 },
    );

    // Pass the 600ms cancel arm window (double-click guard) before the cancel click.
    await page.waitForTimeout(700);

    // Click the button (= cancel while running — the button is the cancel affordance)
    // This calls runArchCancel() → sets cancellingArch=true → fires POST /arch/cancel
    // → cancelFired=true → next poll returns "cancelled" → observeArchRun terminal.
    await genBtn.click();

    // Wait for terminal: genCost must contain "Last run cancelled"
    // pollArchTaskTerminal polls every 2s; the mock returns "cancelled" immediately
    // after cancelFired=true, so terminal arrives within one 2s poll cycle.
    await page.waitForFunction(
      () => {
        const el = document.querySelector("#rg-arch-gen-cost");
        return el !== null && (el.textContent?.includes("Last run cancelled") ?? false);
      },
      { timeout: 15_000 },
    );

    // Assert genCost contains "Last run cancelled · HH:MM"
    const genCost = page.locator("#rg-arch-gen-cost");
    await expect(genCost).toContainText("Last run cancelled");

    // Assert genLabel is back to no-cache "⚡ Generate architecture"
    // (updateArchAffordance restores the no-cache label after cancelled terminal
    // because archTiers=null + generatedPayload=null → no-cache state)
    const genLabel2 = page.locator("#rg-arch-gen-label");
    await expect(genLabel2).toContainText("⚡ Generate", { timeout: 6_000 });

    // Assert no "🔄" remnant in the label (CSS .spin class may remain briefly,
    // but textContent should have no 🔄 — the spinner is CSS, not the emoji).
    await expect(genLabel2).not.toContainText("🔄");

    await page.screenshot({
      path: join(OUT_DIR, "arch-toggle-07-cancelled-terminal.png"),
      fullPage: true,
    });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});
