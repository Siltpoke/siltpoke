// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { RubricTrigger } from "../rubric/types";

const SEV_RANK: Record<"low" | "med" | "high", number> = { high: 3, med: 2, low: 1 };
const MAX_LOW = 5;

export function prioritize(triggers: ReadonlyArray<RubricTrigger>): RubricTrigger[] {
  const seen = new Map<string, RubricTrigger>();
  for (const t of triggers) {
    const key = `${t.rule_id}::${t.file}::${t.line}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  const deduped = [...seen.values()];
  deduped.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

  const result: RubricTrigger[] = [];
  let lowCount = 0;
  for (const t of deduped) {
    if (t.severity === "low") {
      if (lowCount >= MAX_LOW) continue;
      lowCount++;
    }
    result.push(t);
  }
  return result;
}
