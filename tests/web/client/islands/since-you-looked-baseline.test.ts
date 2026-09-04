// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * since-you-looked tests, part 2/3 — unknown_baseline suppression + the
 * staleness line. See `since-you-looked.test.ts` for the split rationale
 * and `_since-you-looked-harness.ts` for the shared fixtures/mount helper.
 *
 * c. `unknown_baseline: true` renders the banner and SUPPRESSES the
 *    per-file rows — even when the (defensively-fed) payload carries
 *    non-empty deltas, proving the suppression is unconditional, not a
 *    coincidence of the real route always sending `deltas: []` here.
 * d. The staleness headline renders verbatim from `data.staleness`, so
 *    "nothing changed" is never shown bare over a stale index.
 *
 * Run: bun test tests/web/client/islands/since-you-looked-baseline.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./_dom-harness";
import {
  DELTA_A,
  DELTA_B,
  STALE_VERDICT,
  apiData,
  mockFetch,
  mountSinceYouLooked,
  rows,
  tick,
} from "./_since-you-looked-harness";

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data, error: null }), {
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  document.body.innerHTML = "";
});

// ── (c) unknown_baseline → banner + suppressed rows, UNCONDITIONALLY ────────

describe("unknown_baseline suppresses per-file rows behind the banner", () => {
  test("unknown_baseline true with EMPTY deltas (the real route's shape) → banner shown, no rows", async () => {
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => Promise.resolve(jsonOk(apiData({ unknown_baseline: true, deltas: [] }))),
      ],
    ]);
    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    expect(root.querySelector("#syl-banner")?.hasAttribute("hidden")).toBe(false);
    expect(rows(root).length).toBe(0);
  });

  test("unknown_baseline true even with NON-EMPTY deltas → still suppressed (not a coincidence)", async () => {
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => Promise.resolve(jsonOk(apiData({ unknown_baseline: true, deltas: [DELTA_A, DELTA_B] }))),
      ],
    ]);
    const root = await mountSinceYouLooked();
    await tick();
    await tick();

    expect(root.querySelector("#syl-banner")?.hasAttribute("hidden")).toBe(false);
    // ── anti-vacuous: prove the suppression is a real branch, not an
    // artifact of an empty deltas array — no "new_to_you" row leaked through.
    expect(rows(root).length).toBe(0);
    expect(root.textContent ?? "").not.toContain("new to you");
  });
});

// ── (d) staleness headline renders verbatim ─────────────────────────────────

describe("staleness line renders from data.staleness", () => {
  test("fresh verdict headline renders", async () => {
    mockFetch([["/api/repo-graph/seen?repo=", () => Promise.resolve(jsonOk(apiData()))]]);
    const root = await mountSinceYouLooked();
    await tick();
    await tick();
    expect(root.querySelector("#syl-staleness")?.textContent).toBe("index is current");
  });

  test("stale verdict headline renders (so 'nothing changed' is never shown bare over a stale index)", async () => {
    mockFetch([
      [
        "/api/repo-graph/seen?repo=",
        () => Promise.resolve(jsonOk(apiData({ staleness: STALE_VERDICT, deltas: [] }))),
      ],
    ]);
    const root = await mountSinceYouLooked();
    await tick();
    await tick();
    expect(root.querySelector("#syl-staleness")?.textContent).toBe("40% out of date — re-index recommended");
    // The empty state ("nothing's changed") still shows, but never bare —
    // the staleness line sits right above it.
    expect(root.querySelector("#syl-empty")?.hasAttribute("hidden")).toBe(false);
  });
});
