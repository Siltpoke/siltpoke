// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */

import { computeProjHash } from "../../repo-graph/proj-hash";
import { tokens } from "../tokens/tokens";

export interface StalenessBadgeProps {
  /** Absolute path of the repo this badge checks — hashed into the `?repo=` query. */
  projectRoot: string;
}

/**
 * Per-row index-staleness badge — an `x-data="stalenessBadge"` Alpine island
 * wired to `GET /api/repo-graph/staleness?repo=<proj_hash>`. Renders one of
 * four states client-side (loading / not_indexed / verdict / check_failed).
 *
 * Extracted out of {@link ActiveReposPanel} (final-review FIX 1, 2026-07-26)
 * to bring that file back under the `lint:files` 400 LOC gate — the markup
 * itself is unchanged (byte-identical to the prior inline block), so
 * `tests/web/staleness-badge.test.ts` (SSR string) and
 * `tests/web/client/islands/staleness-badge.test.ts` (client factory) still
 * pin the same contract with no edits.
 */
export function StalenessBadge({ projectRoot }: StalenessBadgeProps) {
  return (
    <span
      class="staleness-badge"
      x-data="stalenessBadge"
      data-staleness-url={`/api/repo-graph/staleness?repo=${computeProjHash(projectRoot)}`}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      <span class="st-loading" x-show="state === 'loading'" x-cloak style={{ color: tokens.color.ink3 }}>
        · checking…
      </span>
      <span class="st-not-indexed" x-show="state === 'not_indexed'" x-cloak style={{ color: tokens.color.ink3 }}>
        · not indexed — pick this repo on Code Map
      </span>
      <span
        class="st-verdict"
        x-show="state === 'verdict'"
        x-cloak
        x-bind:style="{ color: levelColor(verdict ? verdict.level : undefined) }"
        x-bind:title="verdict ? ('wrong_ratio: ' + Math.round(verdict.counts.wrong_ratio * 100) + '%') : ''"
      >
        <template x-if="verdict && verdict.level === 'fresh'">
          <span role="img" aria-label="index is current">
            ·&nbsp;●
          </span>
        </template>
        <template x-if="verdict && verdict.level !== 'fresh'">
          <span
            x-text="verdict ? ('· ' + verdict.headline + ' (' + verdict.counts.content_changed + ' changed · ' + verdict.counts.deleted_still_indexed + ' deleted · ' + verdict.counts.unindexed_files + ' unindexed)') : ''"
          />
        </template>
      </span>
      <span class="st-check-failed" x-show="state === 'check_failed'" x-cloak style={{ color: tokens.color.terra }}>
        · staleness check failed
      </span>
    </span>
  );
}
