/**
 * trace-history-merge-screenshots.spec.ts — UI-phase rule:
 * full-page PNG captures of the merged /timeline page into
 * test-screenshots/, numbered by user flow. Runs ON GREEN: each
 * test asserts its precondition really holds before snapping, so a capture
 * is evidence, never a decoration.
 *
 *   01 — timeline list + filters (rail rows, filter chips, contextual summary)
 *   02 — Critic tab (user raw query + honesty-labeled agent reply + critique)
 *   03 — Diff tab (haiku summary inline + on-demand per-file diff loaded)
 *   04 — Trace tab (waterfall + brain-span cost table via critique_id join)
 *
 * Fixture data is seeded into the shared e2e SILTPOKE_HOME at spec start and
 * fully restored at the end (see _setup/timeline-e2e-fixtures.ts).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { RestoreFn } from "./_setup/honesty-e2e-fixtures";
import {
  seedTimelineFixtures,
  TL_AGENT_REPLY,
  TL_BUBBLE,
  TL_CRITIQUE_TEXT,
  TL_DIFF_FILE,
  TL_DIFF_INTENT,
  TL_TRACE_ID,
  TL_USER_QUERY,
} from "./_setup/timeline-e2e-fixtures";

const OUT_DIR = join(process.cwd(), "test-screenshots");

let restore: RestoreFn | null = null;

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  restore = await seedTimelineFixtures();
});

test.afterAll(async () => {
  await restore?.();
  restore = null;
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
});

/** The pre-selected dossier = the newest fired turn's pane. */
function visiblePane(page: import("@playwright/test").Page) {
  return page.locator(".tl-detail-pane").first();
}

test("tl-01 — timeline list + filters + contextual summary", async ({ page }) => {
  // With an ACTIVE search filter (?q=) so the shot demonstrates the filter +
  // contextual-summary story — and is visually distinct from tl-02's default
  // view (the two screenshots were pixel-identical, weak evidence).
  await page.goto("/timeline?q=E2E-TL");
  // Rail rows really rendered (fixture turns match the q filter).
  await expect(
    page.locator(".tl-rail").getByText(TL_BUBBLE),
  ).toBeVisible({ timeout: 10_000 });
  // Filter chips (parity) + contextual summary line present.
  await expect(page.locator(".tl-summary")).toContainText("turns ·");
  await expect(page.locator(".tl-summary")).toContainText("$");
  // Chips preserve the active q (the deliberate ripple, now visible).
  expect(await page.content()).toContain("status=all");
  expect(await page.content()).toContain("q=E2E-TL");
  await page.screenshot({
    path: join(OUT_DIR, "01-timeline-list-filters.png"),
    fullPage: true,
  });
});

test("tl-02 — Critic tab: raw query + honesty-labeled agent reply + critique", async ({
  page,
}) => {
  await page.goto("/timeline");
  const pane = visiblePane(page);
  await expect(pane).toBeVisible({ timeout: 10_000 });
  // Critic tab is the default — Block A content from the v2 sidecar.
  await expect(pane.getByText(TL_USER_QUERY).first()).toBeVisible();
  await expect(pane.getByText(TL_AGENT_REPLY).first()).toBeVisible();
  // Honesty caveat on the reply label + critique body.
  await expect(pane.getByText("agent reply (opening").first()).toBeVisible();
  await expect(pane.getByText(TL_CRITIQUE_TEXT).first()).toBeVisible();
  await page.screenshot({
    path: join(OUT_DIR, "02-critic-tab.png"),
    fullPage: true,
  });
});

test("tl-03 — Diff tab: haiku summary + on-demand per-file diff", async ({ page }) => {
  await page.goto("/timeline");
  const pane = visiblePane(page);
  await expect(pane).toBeVisible({ timeout: 10_000 });
  await pane.getByRole("button", { name: "Diff" }).click();
  // Inline haiku summary. filter({visible:true}) — the same intent
  // string also exists in a hidden pane/tab, so match the on-screen one.
  await expect(
    pane.getByText(TL_DIFF_INTENT).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 10_000 });
  // On-demand snapshot fetched and rendered (per-file DiffView rows) —
  // the diff body is NOT SSR-embedded, so seeing the file name proves the
  // /api/critique/:id/diff round trip really happened.
  await expect(
    pane.getByText(TL_DIFF_FILE).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.screenshot({
    path: join(OUT_DIR, "03-diff-tab.png"),
    fullPage: true,
  });
});

test("tl-04 — Trace tab: waterfall + brain-span costs via critique_id join", async ({
  page,
}) => {
  await page.goto("/timeline");
  const pane = visiblePane(page);
  await expect(pane).toBeVisible({ timeout: 10_000 });
  await pane.getByRole("button", { name: "Trace" }).click();
  // Fragment fetched from /api/critique/:id/trace: the linked trace
  // renders with its span-explorer link, cost table and brain span row.
  const trace = pane.locator(`[data-trace-id="${TL_TRACE_ID}"]`);
  await expect(trace).toBeVisible({ timeout: 10_000 });
  await expect(trace.getByText("open span explorer →").first()).toBeVisible();
  await expect(trace.getByText("Brain call cost breakdown", { exact: false })).toBeVisible();
  await expect(trace.getByText("siltpoke.brain.find").first()).toBeVisible();
  // Design fixup (2nd smoke): a span row expands an inline panel IN the page
  // (details/summary + CSS radio tabs) — click the brain span so the shot
  // shows the expanded panel with its Messages/Metadata/Raw tabs.
  const brainRow = trace.locator(".tl-span-details").nth(1);
  await brainRow.locator("summary.tl-span-row").click();
  await expect(brainRow.getByText("Metadata")).toBeVisible();
  await expect(brainRow.locator(".tl-span-explorer-link")).toBeVisible();
  await page.screenshot({
    path: join(OUT_DIR, "04-trace-tab.png"),
    fullPage: true,
  });
});
