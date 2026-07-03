// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /rubric SSR route.
 *
 * Reads ALL_RUBRIC_RULES at request time + optional FP calibration report.
 */
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Layout } from "../_shared/layout";
import { RubricList } from "../screens/RubricList";
import { ALL_RUBRIC_RULES } from "../../critic/rubric/rules";

const CALIBRATION_DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/RUBRIC-CALIBRATION.md",
);

/** Parse trigger counts from the calibration markdown table. */
async function loadCalibration(): Promise<Record<string, number>> {
  if (!existsSync(CALIBRATION_DOC)) return {};
  try {
    const text = await readFile(CALIBRATION_DOC, "utf8");
    const counts: Record<string, number> = {};
    // Match lines like: | magic-number | 1607 | ...
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

export function mountRubricRoutes(app: Hono): void {
  app.get("/rubric", async (c) => {
    const calibration = await loadCalibration();
    return c.html(
      <Layout title="rubric · siltpoke">
        <RubricList rules={ALL_RUBRIC_RULES} calibration={calibration} />
      </Layout>,
    );
  });
}
