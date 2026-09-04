// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Slice ① of critic disk-awareness: a REVERSE_DEPS soft-context section.
 *
 * Wraps Task 1's `importersOf` substrate into a formatted section (for the
 * Brain prompt) plus a bare-canonical-path token list (for the evidence-guard
 * citation corpus, `src/critic/evidence-guard.ts`).
 *
 * Token shape note (cross-family finding): `guardCritique` does a
 * substring-of-corpus check (`citationCorpus.includes(item.file)`), so a
 * `dep:`-prefixed token would ALSO have passed — the bare path is emitted
 * for cleanliness, not because a prefix would have broken the guard.
 *
 * Fail-soft by construction: any failure (importersOf throwing, or any
 * unexpected shape) collapses to `{ section: "", tokens: [] }`. Never throws.
 */

import { isSource } from "./classify";
import { type ImportersDeps, importersOf } from "./importers";
import { canonicalPath } from "./path";

export interface ReverseDepsResult {
  section: string;
  tokens: string[];
}

const HEADER = "=== REVERSE_DEPS (files that import what you changed) ===";

// Re-exported so Task 3 (and any other consumer) can keep importing
// `canonicalPath` from this module by name — the shared implementation now
// lives in `./path` (see that file's docstring for why).
export { canonicalPath };

export function buildReverseDepsSection(
  args: { changedFiles: string[]; cwd: string },
  deps?: ImportersDeps,
): ReverseDepsResult {
  try {
    const sourceFiles = args.changedFiles.filter(isSource);
    if (sourceFiles.length === 0) return { section: "", tokens: [] };

    const map = importersOf(sourceFiles, { cwd: args.cwd, scope: "imports", deps });
    const lines: string[] = [];
    const tokens: string[] = [];
    for (const [file, r] of map) {
      if (r.importers.length === 0) continue;
      const shown = r.importers.map(canonicalPath);
      const marker = r.truncated ? " (+more / uncertain)" : "";
      lines.push(`${canonicalPath(file)} ← imported by: ${shown.join(", ")}${marker}`);
      tokens.push(...shown); // BARE canonical paths — see evidence-guard note above
    }
    if (lines.length === 0) return { section: "", tokens: [] };
    return { section: [HEADER, ...lines].join("\n"), tokens };
  } catch {
    return { section: "", tokens: [] };
  }
}
