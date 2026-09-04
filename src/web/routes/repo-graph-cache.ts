// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Rendered-page cache for GET /repo-graph.
 *
 * The Code Map SSR is dominated by JSX serialization of the ~150KB
 * ArchitectureProjection (~55ms) plus the graph.json parse (~13ms) and the
 * projection/aggregate compute (~8ms) — all a pure function of the on-disk
 * index. `renderRepoGraphPage` recomputed the whole thing on every request
 * (~100ms TTFB, uncached), which is felt as slow Code Map loads and laggy nav.
 *
 * This memoizes the FULL rendered HTML string per project, keyed by the index
 * version (`meta.last_indexed_ts`), so a re-index invalidates instantly. A
 * short TTL bounds the freshness of the two request-live bits baked into the
 * HTML that are NOT index-derived: the git-staleness banner (HEAD vs boot) and
 * the CLAUDE.md §Architecture overlay. Both are advisory / rarely-changing, so
 * a few seconds of staleness on a cache hit is acceptable in exchange for
 * turning a ~100ms render into a ~map-lookup.
 *
 * One entry per project (the Map is keyed by projHash and each project keeps
 * only its latest render), so memory is bounded by the number of indexed repos.
 * Process-local by design — the daemon is single-process; a restart (the only
 * way dist changes) drops the cache, which is correct.
 */

export interface PageCacheEntry {
  /** `meta.last_indexed_ts` the html was rendered from — the invalidation key. */
  indexTs: string;
  html: string;
  /** epoch ms after which this entry is stale regardless of indexTs. */
  expiresAt: number;
}

export interface PageCache {
  /** Cached html iff same project + same index version + not past TTL, else null. */
  get(projHash: string, indexTs: string, nowMs: number): string | null;
  set(projHash: string, indexTs: string, html: string, nowMs: number): void;
}

/** Default freshness window for the request-live bits (staleness banner + CLAUDE.md). */
export const DEFAULT_PAGE_CACHE_TTL_MS = 5000;

export function createPageCache(ttlMs: number = DEFAULT_PAGE_CACHE_TTL_MS): PageCache {
  const store = new Map<string, PageCacheEntry>();
  return {
    get(projHash, indexTs, nowMs) {
      const e = store.get(projHash);
      if (e && e.indexTs === indexTs && nowMs < e.expiresAt) return e.html;
      return null;
    },
    set(projHash, indexTs, html, nowMs) {
      store.set(projHash, { indexTs, html, expiresAt: nowMs + ttlMs });
    },
  };
}
