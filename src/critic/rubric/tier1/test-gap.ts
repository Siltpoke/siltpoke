// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { RubricRule } from "../types";

const THRESHOLD_LINES = 30;
const TEST_PATTERN = /(\.test\.|\.spec\.|^tests?\/|\btest\/|\b__tests__\/)/i;

export const testGapRule: RubricRule = {
  id: "test-gap",
  tier: 1,
  languages: ["*"],
  async run(input) {
    const t0 = performance.now();
    const triggers = [];

    const sourceFiles = new Set<string>();
    const testFiles = new Set<string>();
    const linesAddedPerFile = new Map<string, number>();

    for (const hunk of input.diffHunks) {
      const isTest = TEST_PATTERN.test(hunk.file);
      if (isTest) testFiles.add(hunk.file);
      else sourceFiles.add(hunk.file);
      linesAddedPerFile.set(hunk.file, (linesAddedPerFile.get(hunk.file) ?? 0) + hunk.addedLines.length);
    }

    for (const src of sourceFiles) {
      const added = linesAddedPerFile.get(src) ?? 0;
      if (added <= THRESHOLD_LINES) continue;

      const base = src.replace(/\.(tsx?|jsx?|py)$/, "");
      const hasMatchingTest = [...testFiles].some(t => t.includes(base.split("/").pop() ?? ""));
      if (!hasMatchingTest) {
        triggers.push({
          rule_id: "test-gap",
          tier: 1 as const,
          severity: "med" as const,
          file: src,
          line: 1,
          snippet: `+${added} lines added to ${src}`,
          message: `Source file changed ${added} lines but no corresponding test diff.`,
          suggested_fix: `Add a test in tests/ matching ${src.split("/").pop()}`,
        });
      }
    }

    return { rule_id: "test-gap", triggers, duration_ms: performance.now() - t0 };
  },
};
