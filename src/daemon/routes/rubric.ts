// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /api/rubric — rubric rules + calibration data
 */
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_RUBRIC_RULES } from "../../critic/rubric/rules";

const CALIBRATION_DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/RUBRIC-CALIBRATION.md",
);

async function loadCalibration(): Promise<Record<string, number>> {
  if (!existsSync(CALIBRATION_DOC)) return {};
  try {
    const text = await readFile(CALIBRATION_DOC, "utf8");
    const counts: Record<string, number> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\|\s*([\w-]+)\s*\|\s*(\d+)\s*\|/);
      if (m) {
        const [, ruleId, count] = m;
        if (ruleId && count) counts[ruleId] = Number(count);
      }
    }
    return counts;
  } catch {
    return {};
  }
}

export function mountRubricApiRoutes(app: Hono): void {
  app.get("/api/rubric", async (c) => {
    const calibration = await loadCalibration();
    const rules = ALL_RUBRIC_RULES.map((r) => ({
      id: r.id,
      tier: r.tier,
      languages: r.languages,
    }));
    return c.json({ success: true, data: { rules, calibration } });
  });
}
