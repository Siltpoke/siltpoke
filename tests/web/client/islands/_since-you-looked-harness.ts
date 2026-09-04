// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared fixtures + DOM-mount helper for the since-you-looked test suite,
 * split across sibling `*.test.ts` files to stay under the `lint:files` 400
 * LOC ratchet (mirrors `_dom-harness.ts`'s own underscore-prefixed,
 * non-`.test.ts` convention — excluded from the test runner's file glob,
 * still subject to the same LOC gate as any other source file).
 */
import type { StalenessVerdict } from "../../../../src/repo-graph/staleness-verdict";
import type { SeenFileDelta } from "../../../../src/repo-graph/types";
import { SinceYouLookedPanel } from "../../../../src/web/primitives/SinceYouLookedPanel";
import type { SeenApiData } from "../../../../src/web/client/islands/since-you-looked";
import { jsonResponse } from "./_dom-harness";

export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * URL-substring-routed fetch mock — like `_dom-harness.installFetchMock`,
 * but ALSO forwards `init` (method/headers/body) to the handler. The shared
 * harness's `installFetchMock` deliberately drops `init` (its callers only
 * ever needed the URL); several tests need to assert the advance/mark-all
 * POST's body + `X-Siltpoke-Secret` header, so this local variant carries
 * it through. Same resolve-only-on-unmatched-route behavior.
 */
export type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
export function mockFetch(routes: Array<[match: string, handler: FetchHandler]>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init);
    }
    return Promise.resolve(jsonResponse({ success: true, data: {} }));
  }) as typeof fetch;
}

export const REPO = "f1x7ur3hash0";
export const SECRET = "test-secret-xyz";

export const FRESH_VERDICT: StalenessVerdict = {
  level: "fresh",
  headline: "index is current",
  counts: { content_changed: 0, deleted_still_indexed: 0, unindexed_files: 0, indexed: 5, wrong_ratio: 0 },
  caveat: null,
};

export const STALE_VERDICT: StalenessVerdict = {
  level: "stale",
  headline: "40% out of date — re-index recommended",
  counts: { content_changed: 2, deleted_still_indexed: 0, unindexed_files: 0, indexed: 5, wrong_ratio: 0.4 },
  caveat: null,
};

export function apiData(overrides: Partial<SeenApiData> = {}): SeenApiData {
  return {
    unknown_baseline: false,
    staleness: FRESH_VERDICT,
    deltas: [],
    ...overrides,
  };
}

export const DELTA_A: SeenFileDelta = {
  path: "src/alpha/a.ts",
  baseline_status: "tracked",
  signature_changed: true,
  body_changed: false,
  unparseable: false,
};
export const DELTA_B: SeenFileDelta = {
  path: "src/beta/b.ts",
  baseline_status: "new_to_you",
  signature_changed: false,
  body_changed: false,
  unparseable: false,
};

/** Mount `SinceYouLookedPanel` the way `Memory.tsx` does — nested inside a
 *  `[data-secret]` ancestor (`.memory-book`'s role) — then run the island's
 *  real `init()` via a captured Alpine factory (no real `Alpine.start()`
 *  loop), mirroring `_dom-harness.mountRepoGraph`'s technique. Real Alpine
 *  merges `$el` onto the SAME reactive object the factory returns (so
 *  `this` inside a method sees both `$el` and its sibling methods) —
 *  `.call({ $el: root })` would rebind `this` away from that object and
 *  break every `this.fetchSeen()`/`this.advanceFile()` call inside
 *  `init()`. This mirrors the real merge: call the factory once, stamp
 *  `$el` onto the SAME instance, then invoke `init()` unbound. */
export async function mountSinceYouLooked(): Promise<HTMLElement> {
  const html = String(SinceYouLookedPanel({ projHash: REPO }));
  document.body.innerHTML = `<div data-secret="${SECRET}">${html}</div>`;
  const root = document.querySelector<HTMLElement>('[x-data="sinceYouLooked"]');
  if (!root) throw new Error("fixture missing [x-data=sinceYouLooked] root");

  type Instance = { $el?: HTMLElement; init(): void };
  type Factory = () => Instance;
  let captured: Factory | undefined;
  const fakeAlpine = {
    data: (_name: string, factory: Factory) => {
      captured = factory;
    },
  };
  const island = await import("../../../../src/web/client/islands/since-you-looked");
  island.registerSinceYouLooked(fakeAlpine as never);
  if (!captured) throw new Error("registerSinceYouLooked did not register a factory");
  const instance = captured();
  instance.$el = root;
  instance.init();
  return root;
}

export function rows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".syl-row"));
}
