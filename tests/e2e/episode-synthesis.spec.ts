/**
 * Episode-synthesis — episodes surface in the memory-book
 * episodic slot as distinct narrative rows.
 *
 * Episodes are synthesized OFFLINE (no POST endpoint), so this spec seeds two
 * episodes directly into the shared e2e store's memory.json, drives the real
 * SSR /memory render, asserts the distinct `episode · N events on <day>` label
 * + narrative body appear, then restores the store (isolated — no pollution of
 * sibling specs, which run sequentially on the single shared daemon).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ timezoneId: "UTC" });

const STORE = join(process.cwd(), ".playwright-tmp", "siltpoke", "memory.json");
let original: string;

const EPISODES = [
  {
    id: "ep-e2e-001",
    day_key: "2026-06-25",
    member_fragment_ids: ["ev-e2e-1", "ev-e2e-2", "ev-e2e-3"],
    time_span: { start: "2026-06-25T09:00:00.000Z", end: "2026-06-25T18:00:00.000Z" },
    narrative: "Shipped the memory book UI, wired the episodic slot, and closed the release gate.",
    entity_labels: ["memory-book", "episodic-slot"],
    version: 1,
    created_at: "2026-06-25T18:00:00.000Z",
    updated_at: "2026-06-25T18:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z", // far future so activeEpisodes keeps it
  },
];

test.beforeAll(() => {
  original = readFileSync(STORE, "utf8");
  const mem = JSON.parse(original);
  mem.episodes = EPISODES;
  writeFileSync(STORE, JSON.stringify(mem, null, 2));
});

test.afterAll(() => {
  writeFileSync(STORE, original); // restore — no episodes leak to sibling specs
});

async function waitHydrated(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: unknown[] }> })
        | null;
      return Array.isArray(el?._x_dataStack?.[0]?.memories);
    },
    { timeout: 10_000 },
  );
}

test("episode synthesis: a synthesized episode renders as an episodic row with a distinct label + narrative", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const bodyText = await page.evaluate(() => document.body.innerText);

  // The narrative body is present.
  expect(bodyText).toContain("Shipped the memory book UI");
  // The distinct episode label ("episode · N events on <day>") — tells an
  // episode-narrative row apart from a single event-fragment row.
  expect(bodyText).toMatch(/episode\s*·\s*3\s*events\s*on\s*2026-06-25/);
  // No render crash / undefined leakage.
  expect(bodyText).not.toContain("undefined");
});
// (API-level shape — episode → type:"episodic" row via GET /api/memory-log —
//  is covered deterministically by tests/daemon/memory-log-route.test.ts; the
//  authed endpoint needs the X-Siltpoke-Secret header, out of scope for this
//  SSR-render smoke.)
