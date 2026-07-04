// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { RubricRule } from "../types";

const THRESHOLD_LINES = 500;

export const godFileRule: RubricRule = {
  id: "god-file",
  tier: 1,
  languages: ["*"],
  async run(input) {
    const t0 = performance.now();
    const triggers = [];
    for (const file of input.changedFiles) {
      try {
        const src = await readFile(file, "utf8");
        const lines = src.split("\n").length;
        if (lines > THRESHOLD_LINES) {
          triggers.push({
            rule_id: "god-file",
            tier: 1 as const,
            severity: "high" as const,
            file,
            line: 1,
            end_line: lines,
            snippet: src.slice(0, 200),
            message: `File is ${lines} lines (threshold: ${THRESHOLD_LINES}). Likely doing too many things; consider splitting by responsibility.`,
            suggested_fix: "Split into smaller files organized by feature/domain, not type.",
          });
        }
      } catch {
        // skip unreadable files (deleted in diff, etc.)
      }
    }
    return { rule_id: "god-file", triggers, duration_ms: performance.now() - t0 };
  },
};
