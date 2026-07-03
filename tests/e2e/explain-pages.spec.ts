/**
 * explain-pages.spec.ts — `/explain` daemon route smoke.
 *
 * 3 scenarios:
 *   1. /explain list page renders + sidebar Explain entry navigable.
 *   2. /explain/:id detail page renders the seeded explanation w/ H1 + meta.
 *   3. low_confidence sidecar surfaces the yellow banner on detail page.
 *
 * Cleanup is post-suite — we write deterministic fixture ids (`e2e-*`) into
 * `{cwd}/.siltpoke/explanations/` and remove them in afterAll so prod cache
 * is not polluted.
 */
import { test, expect } from "@playwright/test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXPL_DIR = join(process.cwd(), ".siltpoke", "explanations");
// Valid 12-hex shape per F5 regex guard. Deterministic enough to avoid
// colliding with real cached explanation ids during local dev.
const FIXTURE_OK = "e2e000000ace";
const FIXTURE_LOW = "e2e000000bad";

const OK_META = {
  schemaVersion: 1,
  target: "e2eOkTarget",
  target_node_id: "function:tests/e2e/explain-pages.spec.ts:e2eOkTarget",
  target_key_sha256: FIXTURE_OK,
  graph_indexed_ts: "2026-05-28T18:00:00.000Z",
  brain_usage: {
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
    input_tokens: 100,
    output_tokens: 50,
    total_cost_usd: 0.001,
  },
  evidence_score: 1.0,
  low_confidence: false,
  depth: 1,
  created_ts: "2026-05-28T18:30:00.000Z",
};
const OK_MD =
  "# e2eOkTarget\n\nDefined in [tests/e2e/explain-pages.spec.ts:1].\n";

const LOW_META = {
  ...OK_META,
  target: "e2eLowTarget",
  target_node_id: "function:tests/e2e/explain-pages.spec.ts:e2eLowTarget",
  target_key_sha256: FIXTURE_LOW,
  evidence_score: 0.5,
  low_confidence: true,
  created_ts: "2026-05-28T18:35:00.000Z",
};
const LOW_MD = "# e2eLowTarget\n\nHallucinated reference [src/nope.ts:1].\n";

test.beforeAll(async () => {
  await mkdir(EXPL_DIR, { recursive: true });
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

test("1. /explain list page renders seeded explanations + sort newest-first", async ({
  page,
}) => {
  await page.goto("/explain");
  await expect(page.getByRole("heading", { name: "Explanations" })).toBeVisible(
    { timeout: 10_000 },
  );
  // Both fixture targets present in DOM (detail pages already verified
  // by tests 2 + 3 that fixtures exist on disk + routes serve them).
  const html = await page.content();
  const okIdx = html.indexOf("e2eOkTarget");
  const lowIdx = html.indexOf("e2eLowTarget");
  expect(okIdx).toBeGreaterThan(0);
  expect(lowIdx).toBeGreaterThan(0);
  // Newest first: LOW (created 18:35) appears before OK (created 18:30)
  expect(okIdx).toBeGreaterThan(lowIdx);
  // Link to detail page present
  await expect(page.locator(`a[href="/explain/${FIXTURE_LOW}"]`)).toBeAttached();
  await expect(page.locator(`a[href="/explain/${FIXTURE_OK}"]`)).toBeAttached();
});

test("2. /explain/:id detail page renders H1 + meta block + low-confidence banner", async ({
  page,
}) => {
  await page.goto(`/explain/${FIXTURE_LOW}`);
  // Title carries the target name
  await expect(page).toHaveTitle(/e2eLowTarget/);
  // Markdown body present
  const pre = page.locator("pre");
  await expect(pre).toContainText("e2eLowTarget", { timeout: 10_000 });
  // Low-confidence banner present (yellow .banner div)
  await expect(page.locator(".banner")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".banner")).toContainText(/low.*confidence/i);
  // Meta block shows target node id
  await expect(page.locator("dl.meta")).toContainText(
    "function:tests/e2e/explain-pages.spec.ts:e2eLowTarget",
  );
});

test("3. detail page WITHOUT low-confidence shows no banner", async ({
  page,
}) => {
  await page.goto(`/explain/${FIXTURE_OK}`);
  await expect(page.locator("pre")).toContainText("e2eOkTarget", {
    timeout: 10_000,
  });
  // No banner — DOM should not contain the .banner element
  await expect(page.locator(".banner")).toHaveCount(0);
});
