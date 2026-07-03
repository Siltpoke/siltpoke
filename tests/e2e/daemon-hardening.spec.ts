/**
 * daemon-hardening.spec.ts — e2e for the generate/daemon hardening
 * track (daemon-staleness + output guard).
 *
 * NOTE on the banner visual: the e2e daemon boots AT HEAD (playwright webServer
 * starts `bun src/cli/daemon.ts start` from the current checkout), so
 * `/api/daemon-health` always reports state:"current" here by construction —
 * the "behind" banner cannot fire in e2e without a test affordance we
 * deliberately did NOT add to production code. The three banner branches
 * (behind / current / unknown) are proven by the SSR route unit tests
 * (tests/web/routes/repo-graph.test.ts) driving injected git deps. This spec
 * captures the DETERMINISTIC e2e surface: the endpoint contract + the
 * no-false-nag visual (current → no banner). The live "behind" banner is
 * captured during guided smoke against the real (genuinely stale) daemon.
 */
import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = join(process.cwd(), "tests", "e2e", "screenshots", "daemon-hardening");

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test("1. /api/daemon-health returns the staleness envelope (current at HEAD)", async ({
  request,
}) => {
  const res = await request.get("/api/daemon-health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  // Envelope shape contract (consumed by the banner + doctor).
  expect(body.data).toHaveProperty("bootSha");
  expect(body.data).toHaveProperty("bootTime");
  expect(body.data).toHaveProperty("headSha");
  expect(body.data).toHaveProperty("commitsBehind");
  expect(body.data).toHaveProperty("state");
  // e2e daemon boots at HEAD → current; commitsBehind must be 0 (never a
  // misleading number). If the checkout is non-git in CI it degrades to
  // "unknown" with commitsBehind:null — both are valid, neither is a stray N.
  expect(["current", "unknown"]).toContain(body.data.state);
  if (body.data.state === "current") {
    expect(body.data.commitsBehind).toBe(0);
  } else {
    expect(body.data.commitsBehind).toBeNull();
  }
});

test("2. dashboard renders with NO staleness banner when daemon is current", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/repo-graph");
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  // current/unknown → no false nag. The behind-banner element must be absent.
  await expect(page.locator("#rg-daemon-stale")).toHaveCount(0);
  // No crash: the page mounted (staleness compute never breaks the page).
  await expect(page.locator('[x-data="repoGraph"]')).toBeAttached();
});

test("3. screenshot — dashboard at current (no-nag visual)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/repo-graph");
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.screenshot({
    path: join(OUT_DIR, "01-current-no-banner.png"),
    fullPage: false,
  });
});
