/**
 * explain-screenshots.spec.ts — capture PR-comment Layer 1 screenshots.
 *
 * Runs against the same Playwright daemon fixture as explain-pages.spec.ts,
 * but takes full-page screenshots into test-screenshots/. Output
 * is committed for audit + inlined into the PR comment via gh pr comment
 * --body-file after replacing the [TODO screenshot] placeholders.
 *
 * Three captures match the pages verified by explain-pages.spec.ts:
 *   1. /explain list page
 *   2. /explain/:id detail page
 *   3. /explain/:id w/ low_confidence banner (banner variant)
 *
 * Fixtures use deterministic 12-hex ids (`pr0000*`) so they never collide
 * with prod-cached explanations.
 */
import { test, expect } from "@playwright/test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXPL_DIR = join(process.cwd(), ".siltpoke", "explanations");
const SHOT_DIR = join(process.cwd(), "test-screenshots");

const FIXTURE_OK = "f23000000ace";
const FIXTURE_LOW = "f23000000bad";

const OK_META = {
  schemaVersion: 1,
  target: "runAllChecks",
  target_node_id: "function:src/cli/doctor.ts:runAllChecks",
  target_key_sha256: FIXTURE_OK,
  graph_indexed_ts: "2026-05-28T19:00:00.000Z",
  brain_usage: {
    cache_creation_input_tokens: 32020,
    cache_read_input_tokens: 195673,
    input_tokens: 18,
    output_tokens: 531,
    total_cost_usd: 0.0699,
  },
  evidence_score: 1.0,
  low_confidence: false,
  depth: 1,
  created_ts: "2026-05-28T19:30:00.000Z",
};

const OK_MD = `# runAllChecks

Runs 7 diagnostic checks on siltpoke install health and returns array of results.
Each check (settings.json, stop-hook, inner.txt, wake.json, global schema,
slash symlinks, config.json) inspects a file or state, returns pass/fail
+ detail. Pure read-only — never mutates.

Defined in [src/cli/doctor.ts:267-277]

Calls:
- checkSettingsJson [src/cli/doctor.ts:269]
- checkStopHook [src/cli/doctor.ts:270]
- checkInnerTxt [src/cli/doctor.ts:271]
- checkWakeJson [src/cli/doctor.ts:272]
- checkGlobalSchema [src/cli/doctor.ts:273]
- checkSlashSymlinks [src/cli/doctor.ts:274]
- checkConfigJson [src/cli/doctor.ts:275]

Called by:
- handler (Stop hook) [src/hooks/handler.ts]
`;

const LOW_META = {
  ...OK_META,
  target: "fictionalHelper",
  target_node_id: "function:src/imagined.ts:fictionalHelper",
  target_key_sha256: FIXTURE_LOW,
  evidence_score: 0.4,
  low_confidence: true,
  created_ts: "2026-05-28T19:35:00.000Z",
};

const LOW_MD = `# fictionalHelper

Brain hallucinated a citation pointing at [src/nope.ts:99] which is not in
the repo-graph. Evidence-guard flagged this as low confidence.

Defined in [src/nope.ts:99]
`;

test.beforeAll(async () => {
  await mkdir(EXPL_DIR, { recursive: true });
  await mkdir(SHOT_DIR, { recursive: true });
  await writeFile(join(EXPL_DIR, `${FIXTURE_OK}.md`), OK_MD);
  await writeFile(
    join(EXPL_DIR, `${FIXTURE_OK}.meta.json`),
    JSON.stringify(OK_META, null, 2),
  );
  await writeFile(join(EXPL_DIR, `${FIXTURE_LOW}.md`), LOW_MD);
  await writeFile(
    join(EXPL_DIR, `${FIXTURE_LOW}.meta.json`),
    JSON.stringify(LOW_META, null, 2),
  );
});

test.afterAll(async () => {
  for (const key of [FIXTURE_OK, FIXTURE_LOW]) {
    for (const suffix of [".md", ".meta.json"]) {
      const p = join(EXPL_DIR, `${key}${suffix}`);
      if (existsSync(p)) await unlink(p);
    }
  }
});

test("PR Layer 1 — /explain list page screenshot", async ({ page }) => {
  await page.goto("/explain");
  await expect(page.getByRole("heading", { name: "Explanations" })).toBeVisible({
    timeout: 10_000,
  });
  await page.screenshot({
    path: join(SHOT_DIR, "01-list-page.png"),
    fullPage: true,
  });
});

test("PR Layer 1 — /explain/:id detail (high confidence) screenshot", async ({
  page,
}) => {
  await page.goto(`/explain/${FIXTURE_OK}`);
  await expect(page.locator("pre")).toContainText("runAllChecks", {
    timeout: 10_000,
  });
  await page.screenshot({
    path: join(SHOT_DIR, "02-detail-page.png"),
    fullPage: true,
  });
});

test("PR Layer 1 — /explain/:id low_confidence banner screenshot", async ({
  page,
}) => {
  await page.goto(`/explain/${FIXTURE_LOW}`);
  await expect(page.locator(".banner")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({
    path: join(SHOT_DIR, "03-low-confidence-banner.png"),
    fullPage: true,
  });
});
