// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { LearnedRule } from "../memory/memory";

const FILE_EXT_REGEX = /\b[\w./-]+\.([a-zA-Z][a-zA-Z0-9]{0,4})\b/g;

const COMMON_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "rb", "java", "kt", "swift",
  "c", "cpp", "cc", "h", "hpp", "cs",
  "md", "json", "yaml", "yml", "toml", "sh", "bash", "zsh",
  "sql", "graphql", "proto",
  "html", "css", "scss", "vue", "svelte",
]);

export function detectFileTypes(text: string): Set<string> {
  const types = new Set<string>();
  if (!text) return types;
  for (const match of text.matchAll(FILE_EXT_REGEX)) {
    const ext = match[1]?.toLowerCase();
    if (COMMON_EXTS.has(ext)) {
      types.add(ext);
    }
  }
  return types;
}

interface RuleWithFileTypes extends LearnedRule {
  applies_to_file_types?: string[];
}

function isUniversal(rule: RuleWithFileTypes): boolean {
  return !rule.applies_to_file_types || rule.applies_to_file_types.length === 0;
}

function overlapsTypes(
  rule: RuleWithFileTypes,
  fileTypes: Set<string>,
): boolean {
  if (!rule.applies_to_file_types) return false;
  return rule.applies_to_file_types.some((t) => fileTypes.has(t.toLowerCase()));
}

const EFFECTIVENESS_RANK: Record<string, number> = {
  good: 0,
  neutral: 1,
  retired: 2,
};

function recencyKey(rule: LearnedRule): number {
  const ts = rule.last_triggered_at ?? rule.created_at;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? -parsed : 0;
}

export const DEFAULT_MAX_RULES = 15;

export function selectRelevantRules(
  rules: readonly LearnedRule[],
  fileTypes: Set<string>,
  maxRules: number = DEFAULT_MAX_RULES,
): LearnedRule[] {
  const active = rules.filter((r) => r.effectiveness !== "retired");
  const eligible = active.filter((r) => {
    const withTypes = r as RuleWithFileTypes;
    if (isUniversal(withTypes)) return true;
    if (fileTypes.size === 0) return false;
    return overlapsTypes(withTypes, fileTypes);
  });

  const sorted = [...eligible].sort((a, b) => {
    const ra = EFFECTIVENESS_RANK[a.effectiveness] ?? 1;
    const rb = EFFECTIVENESS_RANK[b.effectiveness] ?? 1;
    if (ra !== rb) return ra - rb;
    return recencyKey(a) - recencyKey(b);
  });

  return sorted.slice(0, Math.max(0, maxRules));
}
