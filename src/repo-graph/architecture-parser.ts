// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Parse a repo's `CLAUDE.md` `## Architecture`
 * section into a super-group + per-subdir-purpose overlay that powers
 * the repo-graph C4 rich-mode view.
 *
 * Returns null when no section is found OR the section yields no
 * parseable subdir entries; caller falls back to the degraded
 * "one panel per immediate child of src/lib/packages/app" mode in
 * `aggregator.ts`.
 *
 * Format expected (matches siltpoke's own CLAUDE.md after
 * /init-harness --refresh):
 *
 *   ## Architecture
 *
 *   **Core LLM + orchestration**
 *   - `src/brain/` — claude -p subprocess (second-opinion reviewer)
 *   - `src/critic/` — 11+ rubric rules, evidence guard, ...
 *
 *   **State / persistence**
 *   - `src/memory/` — Tier 1/2/3 persistence
 *   ...
 */

export interface ArchitectureSubdir {
  /** Repo-relative path with trailing slash (e.g. "src/brain/"). */
  path: string;
  /** One-line purpose string, preserved verbatim including inline backticks/bold. */
  purpose: string;
}

export interface ArchitectureSuperGroup {
  name: string;
  subdirs: ArchitectureSubdir[];
}

export interface ArchitectureOverlay {
  superGroups: ArchitectureSuperGroup[];
}

const ARCHITECTURE_HEADING_RE = /^##\s+architecture\b/i;
const SECTION_END_RE = /^##\s/;
const SUPER_GROUP_RE = /^\*\*([^*]+)\*\*\s*$/;
const SUBDIR_RE = /^-\s+`([^`]+)`\s+(?:—|--|-)\s+(.+)$/;

export function parseArchitectureSection(claudeMdContent: string): ArchitectureOverlay | null {
  const lines = claudeMdContent.split(/\r?\n/);
  let inSection = false;
  let currentGroup: ArchitectureSuperGroup | null = null;
  const superGroups: ArchitectureSuperGroup[] = [];

  for (const line of lines) {
    if (!inSection) {
      if (ARCHITECTURE_HEADING_RE.test(line)) inSection = true;
      continue;
    }
    // Section boundary: any other `## ` heading terminates parsing.
    if (SECTION_END_RE.test(line) && !ARCHITECTURE_HEADING_RE.test(line)) {
      break;
    }
    const groupMatch = SUPER_GROUP_RE.exec(line);
    if (groupMatch) {
      currentGroup = { name: groupMatch[1]!.trim(), subdirs: [] };
      superGroups.push(currentGroup);
      continue;
    }
    const subdirMatch = SUBDIR_RE.exec(line);
    if (subdirMatch && currentGroup) {
      const path = subdirMatch[1]!.trim();
      const purpose = subdirMatch[2]!.trim();
      currentGroup.subdirs.push({ path, purpose });
    }
  }

  // Drop empty super-groups (e.g., bold heading with no following list).
  const populated = superGroups.filter((g) => g.subdirs.length > 0);
  if (populated.length === 0) return null;
  return { superGroups: populated };
}
