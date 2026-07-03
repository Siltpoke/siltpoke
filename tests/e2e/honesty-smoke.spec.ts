/**
 * honesty-smoke.spec.ts — Outside-in smoke for the
 * honesty & observability round.
 *
 * Three user-visible surfaces, driven through the REAL daemon + browser:
 *   1. /history renders ZERO "(no bubble)" placeholders; legacy fired
 *             rows with empty/missing bubble_short are filtered out WHILE a
 *             non-empty control row still renders (anti-vacuous pairing).
 *   2. Brain-health strip: ABSENT on a healthy/fresh home, PRESENT
 *             with the ⚠ class ×count — reason line after seeding an unhealthy
 *             brain-health.json (consecutive_failures = 2) into the e2e home.
 *   3. The repo-graph Generate affordance shows a ≈$
 *             pre-flight figure > $1 for a big seeded fixture (the recalibrated
 *             formula prices cache-write input + 31K output; the old formula
 *             could never exceed ~$0.6 here). Deterministic, NO Brain call.
 *
 * Seeding goes through the same SILTPOKE_HOME the playwright webServer daemon
 * reads per-request (state files are re-read on every request, so no daemon
 * restart is needed). Every seed is restored in afterAll.
 */
import { expect, test } from "@playwright/test";
import {
  BIG_FIXTURE_HASH,
  cleanupBigEstimateFixture,
  LEGACY_EMPTY_MARKER,
  LEGACY_MISSING_MARKER,
  removeBrainHealth,
  type RestoreFn,
  seedBigEstimateFixture,
  seedLegacyBrainCalls,
  seedUnhealthyBrainHealth,
  UNHEALTHY_REASON,
  VISIBLE_BUBBLE,
} from "./_setup/honesty-e2e-fixtures";

// ── history list free of "(no bubble)" rows ────────────────────────────

test.describe("history renders no '(no bubble)' rows", () => {
  let restore: RestoreFn | null = null;

  test.beforeAll(async () => {
    restore = await seedLegacyBrainCalls();
  });
  test.afterAll(async () => {
    await restore?.();
  });

  test("legacy empty/missing-bubble fired rows are filtered; control row renders; zero '(no bubble)' text", async ({
    page,
  }) => {
    // /history 302s to the merged /timeline page, which renders the bubble
    // in BOTH the rail row and the detail pane — hence .first() (the
    // row-filtering behavior under test is unchanged).
    await page.goto("/history");

    // Presence control FIRST (anti-vacuous): the page really shows fired rows.
    await expect(page.getByText(VISIBLE_BUBBLE).first()).toBeVisible({ timeout: 10_000 });

    // Whole-document absence sweep — the placeholder must not appear ANYWHERE.
    const html = await page.content();
    expect(html).not.toContain("(no bubble)");
    // The suppressed rows are gone entirely (including their expand panels).
    expect(html).not.toContain(LEGACY_EMPTY_MARKER);
    expect(html).not.toContain(LEGACY_MISSING_MARKER);
  });
});

// ── Brain-health strip on home ─────────────────────────────────────

test.describe("Brain-health strip", () => {
  let restore: RestoreFn | null = null;

  test.afterAll(async () => {
    if (restore) await restore();
    else await removeBrainHealth();
  });

  test("healthy/fresh home — NO strip element in the DOM", async ({ page }) => {
    await removeBrainHealth(); // fresh-install state (missing file = healthy)
    await page.goto("/");

    // Presence control: the home page itself rendered.
    await expect(page.locator(".home-header")).toBeVisible({ timeout: 10_000 });
    // The strip is EPHEMERAL — healthy means absent, not hidden.
    await expect(page.locator("#brain-health-strip")).toHaveCount(0);
  });

  test("unhealthy (consecutive_failures=2) — strip PRESENT with ⚠ class ×2 + reason", async ({
    page,
  }) => {
    restore = await seedUnhealthyBrainHealth();
    await page.goto("/");

    const strip = page.locator("#brain-health-strip");
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText("⚠ brain: resource ×2");
    await expect(strip).toContainText(UNHEALTHY_REASON);
  });
});

// ── Generate affordance pre-flight ≈$ figure ────────────

test.describe("repo-graph Generate ≈$ estimate", () => {
  test.beforeAll(async () => {
    await seedBigEstimateFixture();
  });
  test.afterAll(async () => {
    await cleanupBigEstimateFixture();
  });

  test("big fixture — Generate affordance renders a ≈$ figure > $1", async ({ page }) => {
    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });

    // Degraded (no CLAUDE.md overlay) → subset arch → the Generate affordance
    // shows and the island fetches the pre-flight estimate.
    await expect(page.locator("#rg-arch-gen")).toBeVisible({ timeout: 10_000 });
    const cost = page.locator("#rg-arch-gen-cost");
    await expect(cost).toContainText("≈$", { timeout: 10_000 });

    const text = (await cost.textContent()) ?? "";
    const match = /≈\$(\d+(?:\.\d+)?)/.exec(text);
    expect(match).not.toBeNull();
    // The recalibrated formula (cache-write input + 31K assumed output) puts a
    // 160K-budget-capped context at ~$1.5; the pre-fix formula topped out well
    // under $1 here — so >$1 pins the NEW pricing end-to-end through the UI.
    expect(Number(match?.[1])).toBeGreaterThan(1);
  });
});
