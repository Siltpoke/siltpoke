// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { RubricRule } from "../types";

const THRESHOLD_LINES = 500;

/**
 * The rule only speaks about SOURCE. "Split by responsibility" is advice about
 * code structure; a document has no responsibilities to split by, and an
 * append-only ledger is supposed to grow.
 *
 * Measured, not assumed: in the 2026-08-21 critic failure corpus, 15 of the 26
 * rubric-restatement findings told `LEDGER.md`, `BACKLOG.md` or
 * `CHANGELOG.md` to split — a split each one's design forbids (the first is a
 * single-writer SSOT, the last is Keep a Changelog, whose sections `/release`
 * extracts by name). See an internal design note
 *
 * This is an ALLOWLIST, not a denylist of documents: an extension nobody listed
 * is more likely to be data than code, and the failure mode being closed here is
 * firing on things that are not source. Unknown and extensionless files stay
 * silent. Add an extension when a real source language turns up missing.
 *
 * It has to live here rather than in the rule's `languages` field, because
 * `engine.ts:17-20` reads that field to decide whether the rule runs AT ALL —
 * `files.some(...)` — and then `run()` walks every changed file regardless. One
 * `.ts` in the diff would let the rule loose on every `.md` beside it.
 */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts",
  "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh",
  "css", "scss", "sass", "less",
  "sql", "vue", "svelte",
]);

function isSource(path: string): boolean {
  const m = path.match(/\.([^./]+)$/);
  return m ? SOURCE_EXTENSIONS.has(m[1].toLowerCase()) : false;
}

export const godFileRule: RubricRule = {
  id: "god-file",
  tier: 1,
  languages: ["*"],
  async run(input) {
    const t0 = performance.now();
    const triggers = [];
    for (const file of input.changedFiles) {
      if (!isSource(file)) continue;
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
