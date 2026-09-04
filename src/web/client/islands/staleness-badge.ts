// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * staleness-badge island — per-repo-row indicator of how far the persisted
 * repo-graph index has drifted from what's on disk right now. Fetches
 * `GET /api/repo-graph/staleness?repo=<projHash>` on init (read-only, no
 * secret needed — matches the other read GETs) and renders one of four
 * states: loading → not_indexed | verdict | check_failed.
 *
 * `check_failed` covers BOTH a non-2xx response and a thrown fetch/parse
 * error — the badge must never silently fall back to blank or "fresh" on
 * a failed check (spec §5.1 negative invariant).
 *
 * Registration: document.addEventListener("alpine:init", ...) so it fires
 * before Alpine.start() walks the DOM. Imported by src/web/client/index.ts.
 * The fetch URL is read from the `data-staleness-url` attribute the SSR
 * panel sets on this element (ActiveReposPanel.tsx) — same "read a data-*
 * attribute in init()" convention as repoRow's data-project-root.
 */
import type { StalenessLevel, StalenessVerdict } from "../../../repo-graph/staleness-verdict";
import { tokens } from "../../tokens/tokens";

export type StalenessBadgeState = "loading" | "not_indexed" | "verdict" | "check_failed";

export interface StalenessBadgeData {
  state: StalenessBadgeState;
  url: string;
  verdict: StalenessVerdict | null;
  init(): void;
  fetchStaleness(): Promise<void>;
  levelColor(level: StalenessLevel | undefined): string;
}

/**
 * Colors per spec §5.1 — `tokens.color.X` (compile-time-checked
 * `var(--color-X)` references), not hand-written `"var(--color-X)"` strings
 * and not hardcoded hex (Task 10b batch 2, controller decision, supersedes
 * this comment's earlier "hardcode to avoid a cross-module import" reasoning
 * — that reasoning predates the dark-mode track establishing the
 * `tokens.color.*` convention across every other island; a typo'd
 * `tokens.color.foo` is a compile error, a typo'd string or hardcoded hex is
 * a silent no-op / a frozen-light-mode bug, this repo's dominant defect
 * shape. Batch 1 already proved the import builds clean in a browser-bundle
 * island (memory-book-helpers.ts); the bundle cost here is one string
 * constant per key, same as there).
 *   fresh → moss (green) · drifting → amber (yellow) · stale/unknown/
 *   check_failed → terra (red) · not_indexed → ink3 (neutral grey).
 */
const LEVEL_COLOR: Record<StalenessLevel, string> = {
  fresh: tokens.color.moss,
  drifting: tokens.color.amber,
  stale: tokens.color.terra,
  unknown: tokens.color.terra,
  not_indexed: tokens.color.ink3,
};
const CHECK_FAILED_COLOR = tokens.color.terra;

export function makeStalenessBadge(fetchFn: typeof fetch = fetch): StalenessBadgeData {
  return {
    state: "loading",
    url: "",
    verdict: null,

    init(): void {
      const el = (this as unknown as { $el?: HTMLElement }).$el;
      this.url = el?.dataset.stalenessUrl ?? "";
      void this.fetchStaleness();
    },

    levelColor(level: StalenessLevel | undefined): string {
      if (!level) return CHECK_FAILED_COLOR;
      return LEVEL_COLOR[level] ?? CHECK_FAILED_COLOR;
    },

    async fetchStaleness(): Promise<void> {
      if (!this.url) {
        this.state = "check_failed";
        return;
      }
      try {
        const res = await fetchFn(this.url);
        if (!res.ok) {
          this.state = "check_failed";
          return;
        }
        const body = (await res.json()) as { success: boolean; data: StalenessVerdict | null };
        if (!body.success || !body.data) {
          this.state = "check_failed";
          return;
        }
        this.verdict = body.data;
        this.state = body.data.level === "not_indexed" ? "not_indexed" : "verdict";
      } catch {
        this.state = "check_failed";
      }
    },
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    (globalThis as { Alpine?: { data: (name: string, factory: () => unknown) => void } }).Alpine?.data(
      "stalenessBadge",
      () => makeStalenessBadge(),
    );
  });
}
