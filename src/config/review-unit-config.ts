// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewUnit } from "../router/review-unit";

/**
 * Which unit of work closes before a review is considered (spec D8).
 *
 * READ-ONLY, and deliberately so. The old `triggerMode` key keeps whatever
 * value it has on disk — every one of its four values means `"commit"` here
 * (AC10) and none of them is ever rewritten (AC11), so a downgrade finds its
 * own setting intact.
 *
 * S5 completed the migration this file's first version deferred: `gateEvents`
 * is gone from the schema and `src/router/trigger-modes.ts` is deleted rather
 * than kept as a shim.
 *
 * The writer is the Timeline page's `reviewUnitRow` island
 * (`src/web/screens/timeline/review-unit-row.tsx` → POST /api/config).
 * This comment used to say "the dashboard writes `reviewUnit`" while the only
 * `<select>` for it sat on the RETIRED report page (`report-artifacts.ts`;
 * `buildReport` has no caller in `src/`) — a sentence that was true of the
 * markup and false of the product for as long as it stood. Name the page, not
 * "the dashboard": that is what made the claim uncheckable.
 */
export function parseReviewUnit(value: unknown): ReviewUnit {
  return value === "pr" ? "pr" : "commit";
}

export async function loadReviewUnit(home: string): Promise<ReviewUnit> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return "commit";
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { reviewUnit?: unknown };
    return parseReviewUnit(parsed.reviewUnit);
  } catch {
    // A config we cannot read must not silence reviews: "commit" is the
    // default and also the more talkative of the two units.
    return "commit";
  }
}
