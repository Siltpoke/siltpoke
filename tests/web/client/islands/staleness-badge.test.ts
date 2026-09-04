// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * staleness-badge factory tests — the four render-state transitions.
 *
 * Tests the pure factory `makeStalenessBadge(fetchFn)` with an injected
 * fetch — no Alpine, no real DOM (mirrors chat-stream's / floating-chat's
 * testable-factory pattern). Covers the mandatory invariant: a failed check
 * (non-2xx OR thrown) must land on `check_failed`, never silently stay
 * blank or fall through to `fresh`.
 */
import { describe, expect, test } from "bun:test";
import type { StalenessVerdict } from "../../../../src/repo-graph/staleness-verdict";
import { makeStalenessBadge } from "../../../../src/web/client/islands/staleness-badge";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

const FRESH_VERDICT: StalenessVerdict = {
  level: "fresh",
  headline: "index is current",
  counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, indexed: 5, wrong_ratio: 0 },
  caveat: null,
};

const STALE_VERDICT: StalenessVerdict = {
  level: "stale",
  headline: "40% out of date — re-index recommended",
  counts: { content_changed: 2, deleted_still_indexed: 0, unindexed_files: 0, indexed: 5, wrong_ratio: 0.4 },
  caveat: null,
};

const NOT_INDEXED_VERDICT: StalenessVerdict = {
  level: "not_indexed",
  headline: "not indexed — run /siltpoke-index",
  counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, indexed: 0, wrong_ratio: 0 },
  caveat: null,
};

function fakeEl(url: string): HTMLElement {
  return { dataset: { stalenessUrl: url } } as unknown as HTMLElement;
}

/** Cast a minimal fetch stub to `typeof fetch` (mirrors chat-stream.test.ts —
 * bun/dom's `typeof fetch` also requires `preconnect`, irrelevant here). */
function ff(handler: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch;
}

describe("makeStalenessBadge — state transitions", () => {
  test("starts in loading", () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({ success: true, data: FRESH_VERDICT })));
    expect(badge.state).toBe("loading");
  });

  test("2xx + level fresh → verdict state, verdict stored verbatim", async () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({ success: true, data: FRESH_VERDICT })));
    (badge as unknown as { $el?: HTMLElement }).$el = fakeEl("/api/repo-graph/staleness?repo=abc");
    badge.init();
    await badge.fetchStaleness();
    expect(badge.state).toBe("verdict");
    expect(badge.verdict).toEqual(FRESH_VERDICT);
  });

  test("2xx + level stale → verdict state (non-fresh)", async () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({ success: true, data: STALE_VERDICT })));
    badge.url = "/api/repo-graph/staleness?repo=abc";
    await badge.fetchStaleness();
    expect(badge.state).toBe("verdict");
    expect(badge.verdict?.level).toBe("stale");
  });

  test("2xx + level not_indexed → not_indexed state", async () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({ success: true, data: NOT_INDEXED_VERDICT })));
    badge.url = "/api/repo-graph/staleness?repo=abc";
    await badge.fetchStaleness();
    expect(badge.state).toBe("not_indexed");
  });

  test("non-2xx response → check_failed, never fresh/blank", async () => {
    const badge = makeStalenessBadge(
      ff(async () => jsonResponse({ success: false, data: null, error: "bad_repo" }, { status: 400 })),
    );
    badge.url = "/api/repo-graph/staleness?repo=abc";
    await badge.fetchStaleness();
    expect(badge.state).toBe("check_failed");
    expect(badge.verdict).toBeNull();
  });

  test("thrown fetch (network error) → check_failed", async () => {
    const badge = makeStalenessBadge(
      ff(async () => {
        throw new Error("network down");
      }),
    );
    badge.url = "/api/repo-graph/staleness?repo=abc";
    await badge.fetchStaleness();
    expect(badge.state).toBe("check_failed");
  });

  test("2xx but success:false envelope → check_failed (not silently fresh)", async () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({ success: false, data: null })));
    badge.url = "/api/repo-graph/staleness?repo=abc";
    await badge.fetchStaleness();
    expect(badge.state).toBe("check_failed");
  });

  test("missing url (init found no data-staleness-url) → check_failed", async () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({ success: true, data: FRESH_VERDICT })));
    await badge.fetchStaleness();
    expect(badge.state).toBe("check_failed");
  });

  test("init() reads the URL from the $el data-staleness-url attribute", async () => {
    const seen: string[] = [];
    const badge = makeStalenessBadge(
      ff(async (input) => {
        seen.push(String(input));
        return jsonResponse({ success: true, data: FRESH_VERDICT });
      }),
    );
    (badge as unknown as { $el?: HTMLElement }).$el = fakeEl("/api/repo-graph/staleness?repo=xyz789");
    badge.init();
    await Promise.resolve(); // let the void fetchStaleness() in init() settle
    expect(seen).toContain("/api/repo-graph/staleness?repo=xyz789");
  });
});

describe("makeStalenessBadge — levelColor (color-coding invariant)", () => {
  // Task 10b batch 2: LEVEL_COLOR/CHECK_FAILED_COLOR now hold `tokens.color.X`
  // (= `var(--color-X)`) rather than a hardcoded hex — same values, theme-aware.
  test("fresh is green, drifting is amber/yellow, stale/unknown are red", () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({})));
    expect(badge.levelColor("fresh")).toBe("var(--color-moss)");
    expect(badge.levelColor("drifting")).toBe("var(--color-amber)");
    expect(badge.levelColor("stale")).toBe("var(--color-terra)");
    expect(badge.levelColor("unknown")).toBe("var(--color-terra)");
    expect(badge.levelColor("not_indexed")).toBe("var(--color-ink3)"); // neutral grey
  });

  test("not_indexed/unknown/undefined are all non-green", () => {
    const badge = makeStalenessBadge(ff(async () => jsonResponse({})));
    const green = "var(--color-moss)";
    expect(badge.levelColor("not_indexed")).not.toBe(green);
    expect(badge.levelColor("unknown")).not.toBe(green);
    expect(badge.levelColor(undefined)).not.toBe(green);
  });
});
