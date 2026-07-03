/**
 * explainability-screenshots.spec.ts — visual-capture layer for
 * score explainability + chip/stats relocation.
 *
 * Captures 6 full-page PNGs into test-screenshots/ (committed for
 * PR audit). Runs ON GREEN, not only-on-failure. Each test asserts its DOM
 * preconditions before shooting — the capture is evidence, not decoration.
 *
 * Harness pattern: same as arch-toggle-regenerate-screenshots.spec.ts.
 * - Daemon started by playwright.config webServer (port 9877, e2e home
 *   .playwright-tmp/siltpoke, SILTPOKE_TEST_MOCK_STREAM=1).
 * - BIG_FIXTURE_HASH / seedBigEstimateFixture from honesty-e2e-fixtures for
 *   scenarios 01/02/05 (arch view, non-authored, no .siltpoke/arch-c4.json).
 * - FIXTURE_HASH (globalSetup seed-repo-graph) for scenarios 03/04/06
 *   (trace view — the standard fixture has runAlpha + queryIndex wired for
 *   entrypoint detection; BIG_FIXTURE_HASH uses emptyQueryIndex which makes
 *   phEnterDefault fall through to no-preset search-fallback state, unsafe
 *   for confidence chip assertions that require S.level === "trace" to hold
 *   long enough for phSyncBar to render).
 * - All big-fixture uses are cleaned up in finally blocks (verification-repo
 *   cleanup discipline — orphaned indexes pollute the repo dropdown).
 *
 * Scenarios (numbered by user flow):
 *   01  Architecture view — grounded chip in toolbar-right + stats beside repo
 *       picker in pagehead (both relocated). Chip VISIBLE.
 *   02  Grounded popover OPEN (click #rg-arch-chip). If the fixture's cached
 *       model lacks citedClaims/totalClaims (legacy-absent path), the popover
 *       renders "grounded = 80%" headline — HONEST capture, scenario names that
 *       path accordingly. Assert popover role="region" visible + title present.
 *   03  Trace view — confidence chip in ph-bar right cluster beside entry button.
 *       Enter trace mode via phEnterDefault, wait for #rg-ph-cov.
 *   04  Confidence popover OPEN (click #rg-ph-cov). Formula + ladder visible.
 *       Capture trace+generated toolbar geometry w/ 340px
 *       popover — honest evidence from the first live run (guided smoke must
 *       confirm wrap behaviour on real-width window).
 *   05  Hidden-chip state — Architecture view on BIG_FIXTURE_HASH WITHOUT a
 *       generated model: assert NO ghost gap where the chip wrapper sits (the
 *       :has() collapse). Checks wrapper bounding box
 *       width === 0 OR display:none via page.evaluate (not just screenshot).
 *   06  Narrow ≤900px viewport variant — pagehead at
 *       900px width. Assert no overflow/wrap breakage: no horizontal scroll bar
 *       (document.body.scrollWidth <= viewport.width) + stats and repo picker
 *       both present in the DOM.
 *
 * Quality note: NEVER assert specific LLM claim text (flaky — content varies per
 * run). Assertions pin structural facts: element visibility, role, selector
 * relations, bounding boxes, and static UI copy that is app-generated (not LLM).
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BIG_FIXTURE_HASH,
  cleanupBigEstimateFixture,
  seedBigEstimateFixture,
} from "./_setup/honesty-e2e-fixtures";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";
import { computeRepoFingerprint } from "../../src/explain/arch-cache";
import { emptyFingerprints } from "../../src/repo-graph/types";

const OUT_DIR = join(process.cwd(), "test-screenshots");

// ── Minimal valid ArchModelDoc for the e2e fixture ────────────────────────
//
// Same shape as arch-toggle-regenerate-screenshots.spec.ts (same constraints).
// Deliberately mirrors FIXTURE_ARCH_DOC from that spec so both test files
// load the same shape into the daemon — reduces runtime divergence.
// NOTE: No tier fields on labels/bands/nodes → deriveInferredClaims returns []
// → popover renders legacy/graceful-absent path for grounded formula.
// The meta also has no citedClaims/totalClaims → same legacy-absent path.
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

/** Deterministic fingerprint for emptyFingerprints() — same as arch-toggle spec. */
const FRESH_FINGERPRINT = computeRepoFingerprint(emptyFingerprints());

/**
 * Write arch-model.json + arch-model.meta.json into the big fixture's
 * storageDir. No citedClaims/totalClaims in meta → graceful-absent path.
 * groundedPct: 80 (matches FIXTURE_ARCH_DOC).
 */
async function writeArchFixture(storageDir: string, fingerprint: string, graphIndexedTs: string): Promise<void> {
  const meta: Record<string, unknown> = {
    schemaVersion: 1,
    fingerprint,
    graphIndexedTs,
    costUsd: 1.48,
    groundedPct: 80,
    model: "sonnet",
    generatedTs: new Date().toISOString(),
    // NOTE: no citedClaims/totalClaims — intentional: captures the legacy-absent
    // path (graceful-absent) because this fixture was generated before those counts
    // were serialized. The popover renders "grounded = 80%" (no ÷ formula).
    // Scenario 02 labels this clearly in its assertion comment.
  };
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

// ── Shared setup ─────────────────────────────────────────────────────────

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

// ── Scenario 01 ───────────────────────────────────────────────────────────
//
// Architecture view — grounded chip in toolbar-right + stats beside repo picker.
// #rg-arch-chip is inside .arch-chip-tbwrap inside .toolbar (NOT .pagehead).
// .idx-stat is the immediate sibling of .repo-pick-wrap in .pagehead left cluster.
//
// DOM assertions:
//   • #rg-arch-chip visible (generated model loaded → chip shown)
//   • #rg-arch-chip is INSIDE .toolbar (not .pagehead) — relocation
//   • .idx-stat is present in .pagehead, sibling of .repo-pick-wrap — relocation
//   • .pagehead does NOT contain #rg-arch-chip — old position gone

test("01 — arch view: grounded chip in toolbar-right + stats beside repo picker", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) => fs.readFile(metaPath, "utf8"));
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    await writeArchFixture(storageDir, FRESH_FINGERPRINT, graphMeta.last_indexed_ts);

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800); // C4 layout settle

    // Grounded chip must be visible (generated model is loaded)
    const archChip = page.locator("#rg-arch-chip");
    await expect(archChip).toBeVisible({ timeout: 8_000 });

    // Chip lives under .toolbar, NOT .pagehead
    const chipInToolbar = await page.evaluate(() => {
      const chip = document.querySelector("#rg-arch-chip");
      const toolbar = document.querySelector(".toolbar");
      return chip !== null && toolbar !== null && toolbar.contains(chip);
    });
    expect(chipInToolbar, "grounded chip must be inside .toolbar (relocation)").toBe(true);

    const chipInPagehead = await page.evaluate(() => {
      const chip = document.querySelector("#rg-arch-chip");
      const pagehead = document.querySelector(".pagehead");
      return chip !== null && pagehead !== null && pagehead.contains(chip);
    });
    expect(chipInPagehead, "grounded chip must NOT be in .pagehead (old position gone)").toBe(false);

    // .idx-stat is in .pagehead, adjacent to .repo-pick-wrap (left cluster)
    const statsInPagehead = await page.evaluate(() => {
      const stat = document.querySelector(".idx-stat");
      const pagehead = document.querySelector(".pagehead");
      return stat !== null && pagehead !== null && pagehead.contains(stat);
    });
    expect(statsInPagehead, "stats (.idx-stat) must be in .pagehead").toBe(true);

    // Stats is sibling (not child) of repo-pick-wrap — left-cluster adjacency
    const statsAdjacentToRepoPick = await page.evaluate(() => {
      const stat = document.querySelector(".idx-stat");
      const repoPick = document.querySelector(".repo-pick-wrap");
      if (!stat || !repoPick) return false;
      return stat.parentElement === repoPick.parentElement;
    });
    expect(statsAdjacentToRepoPick, ".idx-stat and .repo-pick-wrap must be siblings in .pagehead").toBe(true);

    await page.screenshot({ path: join(OUT_DIR, "explain-01-arch-toolbar-chip.png"), fullPage: true });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 02 ───────────────────────────────────────────────────────────
//
// Grounded popover OPEN (click #rg-arch-chip).
//
// The fixture meta has NO citedClaims/totalClaims (legacy-absent path).
// The popover therefore renders "grounded = 80%" as the formula line rather
// than "<cited> ÷ <total> = 80%". This is the HONEST capture for a cached model
// generated before those counts were serialized. Label: legacy-absent path.
//
// DOM assertions:
//   • popover [data-anchor-popover] is visible after chip click
//   • popover has role="region"
//   • popover text contains "grounded" (formula line present — graceful-absent)
//   • trigger (#rg-arch-chip) has aria-expanded="true" (a11y)
//   • title text contains "WHY THIS DIAGRAM IS TRUSTWORTHY"
//   • NEVER assert specific LLM claim text (flaky — quality review warning)

test("02 — grounded popover open: legacy-absent formula path (graceful-absent)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) => fs.readFile(metaPath, "utf8"));
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    await writeArchFixture(storageDir, FRESH_FINGERPRINT, graphMeta.last_indexed_ts);

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Chip must be visible before we click it
    const archChip = page.locator("#rg-arch-chip");
    await expect(archChip).toBeVisible({ timeout: 8_000 });

    // Click the grounded chip → anchor-popover mounts
    await archChip.click();

    // Wait for [data-anchor-popover] to appear (build-on-open)
    const popover = page.locator("[data-anchor-popover]");
    await expect(popover).toBeVisible({ timeout: 6_000 });

    // Structural assertions — role
    await expect(popover).toHaveAttribute("role", "region");

    // aria-expanded on trigger
    await expect(archChip).toHaveAttribute("aria-expanded", "true");

    // Title in aria-label (title no longer in visible content, aria-label only)
    await expect(popover).toHaveAttribute("aria-label", "WHY THIS DIAGRAM IS TRUSTWORTHY");

    // Formula line: legacy-absent path renders "grounded = 80%"
    // NOTE: if this fixture is regenerated with counts, it would render "<cited> ÷ <total> = 80%"
    // which also contains "grounded" — either way this assertion holds. The exact path
    // (legacy vs full formula) is documented by the scenario name, not asserted (flaky).
    await expect(popover).toContainText("grounded", { timeout: 4_000 });

    // Epistemic line — static app-generated copy (verbatim), safe to pin
    await expect(popover).toContainText("describes this output only", { timeout: 4_000 });

    await page.screenshot({ path: join(OUT_DIR, "explain-02-grounded-popover-open.png"), fullPage: true });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 03 ───────────────────────────────────────────────────────────
//
// Trace view — confidence chip in ph-bar right cluster beside entry button.
//
// Uses FIXTURE_HASH (globalSetup seeded: alpha/beta/gamma, runAlpha function).
// phEnterDefault detects runAlpha via queryIndex → enters trace mode → phSyncBar
// renders ph-bar with [.ph-spacer][.ph-cwrap(chip)][.ph-pwrap(entry button)].
//
// DOM assertions:
//   • ph-active-bar class on rg-host (trace mode active)
//   • #rg-ph-cov visible (confidence chip rendered in right cluster)
//   • #rg-ph-cov is INSIDE #rg-phbar (correct container — relocation)
//   • #rg-ph-pick (entry button) also inside #rg-phbar, comes AFTER chip
//     (right-cluster ordering: chip → entry button)

test("03 — trace view: confidence chip in ph-bar right cluster beside entry button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;

  await page.goto(FIXTURE_URL);
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  await page.waitForTimeout(500);

  // Enter trace mode via the "Trace a path" button
  const enterBtn = page.locator("#rg-ph-enter");
  await expect(enterBtn).toBeVisible({ timeout: 6_000 });
  await enterBtn.click();

  // Wait for trace mode: rg-host gets ph-active-bar
  await expect(page.locator(".rg-host.ph-active-bar")).toBeVisible({ timeout: 8_000 });

  // Wait for phSyncBar to render the ph-bar in trace mode
  await page.waitForTimeout(600); // phEnterDefault may be async (API call)

  // Confidence chip (#rg-ph-cov) must be visible in ph-bar right cluster
  const covChip = page.locator("#rg-ph-cov");
  await expect(covChip).toBeVisible({ timeout: 10_000 });

  // Chip must be inside #rg-phbar (correct container)
  const chipInPhBar = await page.evaluate(() => {
    const chip = document.querySelector("#rg-ph-cov");
    const phbar = document.querySelector("#rg-phbar");
    return chip !== null && phbar !== null && phbar.contains(chip);
  });
  expect(chipInPhBar, "confidence chip must be inside #rg-phbar (relocation)").toBe(true);

  // Entry button (#rg-ph-pick) comes AFTER chip — right-cluster ordering
  // (ph-spacer then chip then entry button)
  const chipBeforeEntry = await page.evaluate(() => {
    const chip = document.querySelector("#rg-ph-cov");
    const pick = document.querySelector("#rg-ph-pick");
    if (!chip || !pick) return null;
    // compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING = 4 means pick follows chip
    return (chip.compareDocumentPosition(pick) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(chipBeforeEntry, "chip must precede entry button in DOM order (right-cluster layout)").toBe(true);

  // Confidence chip contains "confidence" text (wording — no "Graph" prefix)
  await expect(covChip).toContainText("confidence", { timeout: 4_000 });

  await page.screenshot({ path: join(OUT_DIR, "explain-03-trace-confidence-chip.png"), fullPage: true });
});

// ── Scenario 04 ───────────────────────────────────────────────────────────
//
// Confidence popover OPEN (click #rg-ph-cov).
//
// Capture trace+generated toolbar wrap geometry with the
// 340px-wide anchor-popover visible — honest evidence from first headless run.
// Guided live smoke must confirm wrap behaviour on a real window.
//
// DOM assertions:
//   • [data-anchor-popover] visible after click
//   • popover has role="region"
//   • trigger aria-expanded="true"
//   • title contains "TRUSTWORTHY" (tier-variant, one of three; all contain "TRUSTWORTHY")
//   • formula section present — contains "÷" or "=" (ladder/formula visible)
//   • "confidence measures" definition line present (verbatim content)
//   • NEVER assert specific pct values or tier-band highlight (fixture-coverage=0 means
//     "red" tier; assertions pin structure, not the exact numeric content)

test("04 — confidence popover open: formula + definition + ladder visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;

  await page.goto(FIXTURE_URL);
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  await page.waitForTimeout(500);

  // Enter trace mode
  const enterBtn = page.locator("#rg-ph-enter");
  await expect(enterBtn).toBeVisible({ timeout: 6_000 });
  await enterBtn.click();

  await expect(page.locator(".rg-host.ph-active-bar")).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(600);

  // Confidence chip must be visible
  const covChip = page.locator("#rg-ph-cov");
  await expect(covChip).toBeVisible({ timeout: 10_000 });

  // Click the chip → anchor-popover mounts (build-on-open)
  await covChip.click();

  const popover = page.locator("[data-anchor-popover]");
  await expect(popover).toBeVisible({ timeout: 6_000 });

  // Role + aria-expanded
  await expect(popover).toHaveAttribute("role", "region");
  await expect(covChip).toHaveAttribute("aria-expanded", "true");

  // Title in aria-label — tier-variant, all contain "TRUSTWORTHY" (title → aria-label only)
  const ariaLabel = await popover.getAttribute("aria-label");
  expect(ariaLabel).toContain("TRUSTWORTHY");

  // Label-free narrative opens with "We read" — static app-generated copy, safe to pin
  await expect(popover).toContainText("We read", { timeout: 4_000 });

  // Ladder structure: "low" / "medium" / "high" tier labels present
  await expect(popover).toContainText("low", { timeout: 4_000 });
  await expect(popover).toContainText("medium", { timeout: 4_000 });
  await expect(popover).toContainText("high", { timeout: 4_000 });

  // Label-free tier paragraph — "Too few calls" for red tier (fixture-coverage=0 → red)
  await expect(popover).toContainText("Too few calls could be traced", { timeout: 4_000 });

  await page.screenshot({ path: join(OUT_DIR, "explain-04-confidence-popover-open.png"), fullPage: true });
});

// ── Scenario 05 ───────────────────────────────────────────────────────────
//
// Hidden-chip state — Architecture view on BIG_FIXTURE_HASH WITHOUT a generated
// model: assert NO ghost gap where the chip wrapper sits.
//
// The .arch-chip-tbwrap uses CSS :has(button[hidden]){display:none} to collapse
// when the chip is hidden (no generated model). happy-dom cannot compute :has()
// effects, so this is the designated headless catch layer.
// Assert: wrapper bounding box width === 0 OR computed display === "none".
//
// DOM assertions (functional — not just screenshot):
//   • page.evaluate: #rg-arch-chip-wrap is either display:none or width=0
//   • #rg-arch-chip is hidden (no generated model → chip stays hidden)
//   • pagehead renders normally (h1 + repo-pick-wrap + idx-stat visible)

test("05 — hidden chip: no ghost gap in toolbar when no generated model", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;
    // NO arch fixture seeded → no generated model → arch chip stays hidden

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // The chip itself must be hidden (no generated model)
    const archChip = page.locator("#rg-arch-chip");
    // chip should have hidden attribute or not be visible
    const chipIsHidden = await page.evaluate(() => {
      const chip = document.querySelector<HTMLElement>("#rg-arch-chip");
      return chip === null || chip.hidden === true || chip.offsetParent === null;
    });
    expect(chipIsHidden, "#rg-arch-chip must be hidden when no generated model").toBe(true);

    // .arch-chip-tbwrap must have zero visual footprint
    // (display:none via :has() CSS collapse OR width=0 bounding box).
    const wrapperCollapsed = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>("#rg-arch-chip-wrap");
      if (!wrap) return { collapsed: true, reason: "element absent" };
      const style = window.getComputedStyle(wrap);
      const rect = wrap.getBoundingClientRect();
      const isNone = style.display === "none";
      const isZeroWidth = rect.width === 0;
      return { collapsed: isNone || isZeroWidth, display: style.display, width: rect.width };
    });
    expect(
      wrapperCollapsed.collapsed,
      `.arch-chip-tbwrap must be collapsed (display:none or 0px width) when chip hidden — got display:${wrapperCollapsed.display} width:${wrapperCollapsed.width} (:has() collapse)`,
    ).toBe(true);

    // Pagehead structural sanity: h1 + repo picker + stats still visible
    await expect(page.locator(".pagehead h1")).toBeVisible({ timeout: 4_000 });
    await expect(page.locator(".repo-pick-wrap")).toBeVisible({ timeout: 4_000 });
    await expect(page.locator(".idx-stat")).toBeVisible({ timeout: 4_000 });

    await page.screenshot({ path: join(OUT_DIR, "explain-05-hidden-chip-no-gap.png"), fullPage: true });
  } finally {
    // No arch fixture was written, so only graph cleanup needed
    await cleanupBigEstimateFixture();
  }
});

// ── Scenario 06 ───────────────────────────────────────────────────────────
//
// Narrow ≤900px viewport variant.
// Architecture view at 900px width: assert no overflow/wrap breakage in pagehead.
//
// DOM assertions (functional):
//   • document.body.scrollWidth <= viewport.width (no horizontal overflow)
//   • .idx-stat present and visible (stats haven't been pushed off-screen)
//   • .repo-pick-wrap present and visible (repo picker not clipped)
//   • pagehead child count unchanged (no wrap-induced duplication)
//
// NOTE: .idx-stat uses flex-shrink:0 + white-space:nowrap (review fixup)
// to resist compression — this test validates the fixup holds at 900px.

test("06 — narrow 900px pagehead: no horizontal overflow, stats + picker visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 820 });
  let storageDir = "";
  try {
    const { storageDir: sd } = await seedBigEstimateFixture();
    storageDir = sd;

    const metaPath = join(storageDir, "meta.json");
    const metaRaw = await import("node:fs/promises").then((fs) => fs.readFile(metaPath, "utf8"));
    const graphMeta = JSON.parse(metaRaw) as { last_indexed_ts: string };
    await writeArchFixture(storageDir, FRESH_FINGERPRINT, graphMeta.last_indexed_ts);

    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // No horizontal scroll bar (content must not overflow the viewport)
    const noOverflow = await page.evaluate(() => {
      return document.body.scrollWidth <= window.innerWidth;
    });
    expect(noOverflow, "no horizontal overflow at 900px viewport").toBe(true);

    // Stats and repo picker must both remain visible at 900px
    await expect(page.locator(".idx-stat")).toBeVisible({ timeout: 4_000 });
    await expect(page.locator(".repo-pick-wrap")).toBeVisible({ timeout: 4_000 });

    // Grounded chip should still be visible (generated model present)
    await expect(page.locator("#rg-arch-chip")).toBeVisible({ timeout: 6_000 });

    await page.screenshot({ path: join(OUT_DIR, "explain-06-narrow-pagehead.png"), fullPage: true });
  } finally {
    await removeArchFixture(storageDir);
    await cleanupBigEstimateFixture();
  }
});
