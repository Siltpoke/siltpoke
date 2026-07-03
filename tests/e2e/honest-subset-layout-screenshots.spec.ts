/**
 * honest-subset-layout-screenshots.spec.ts — degraded band grouping (live).
 *
 * The globalSetup fixture (FIXTURE_HASH) is a SINGLE-ROOT repo: src/alpha,
 * src/beta, src/gamma. With no CLAUDE.md Architecture overlay it renders the
 * honest-subset (degraded) C4 — exercising the single-root degenerate
 * end-to-end through SSR (threads ProjectionSubdir.path) + client
 * (deriveC4FromProjection first-segment grouping):
 *   - exactly ONE band (all containers share first segment "src"),
 *   - labelled with the VERBATIM segment "src" (lowercase — NOT "SRC", NOT a
 *     dir→layer guess like "Service"/"UI"),
 *   - all three containers flowing inside that one band (not a vertical stack
 *     of three single-member bands).
 *
 * The multi-namespace 4-band case (backend/frontend/packages/scripts) is
 * verified live on a real monorepo index.
 */
import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";

const OUT_DIR = join(process.cwd(), "test-screenshots");
const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test("single-root degraded → one verbatim 'src' band", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(FIXTURE_URL);
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  await page.waitForTimeout(1500); // let the C4 mount + lay out

  const labels = await page.locator(".c4-bandlab").allTextContents();
  // exactly one band, labelled with the literal first segment "src"
  expect(labels).toHaveLength(1);
  expect(labels[0]).toBe("src");
  // NOT uppercased, NOT a layer-name guess
  expect(labels[0]).not.toBe("SRC");

  // all three containers present (one band of N, not N stacked bands)
  const conts = await page
    .locator(".c4-node.accent-sky, .c4-node.accent-terra, .c4-node.accent-moss, .c4-node.accent-amber")
    .count();
  expect(conts).toBe(3);

  await page.screenshot({
    path: join(OUT_DIR, "honest-subset-singleroot-fixture.png"),
    fullPage: false,
  });
});
