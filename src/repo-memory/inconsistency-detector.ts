// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { loadIndex } from "./index-builder.ts";
import type { RepoMemoryIndex } from "./types.ts";
import type { RubricRule, RubricInput, RubricRuleResult, RubricTrigger } from "../critic/rubric/types.ts";

// Extract the dominant export style from file source
function getExportStyle(source: string): "named-const" | "default" | "mixed" | "none" {
  const hasNamedConst = /^export\s+const\s+/m.test(source);
  const hasDefault = /^export\s+default\s+/m.test(source);
  if (hasNamedConst && hasDefault) return "mixed";
  if (hasNamedConst) return "named-const";
  if (hasDefault) return "default";
  return "none";
}

async function checkFile(
  filePath: string,
  index: RepoMemoryIndex,
): Promise<RubricTrigger | null> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const dir = dirname(filePath);
  const name = basename(filePath);

  // Find similar files: same directory segment or matching name prefix
  // Index paths are cwd-relative (e.g. "src/critic/rule-0.ts"), so compare by the
  // last directory segment (e.g. "critic") rather than the full absolute path.
  const dirSegment = basename(dir);
  const prefix = name.replace(/\.[^.]+$/, "").split("-")[0] ?? "";
  const similarFiles = index.files.filter((f) => {
    const fDirSegment = basename(dirname(f.path));
    const fBase = basename(f.path).replace(/\.[^.]+$/, "").split("-")[0] ?? "";
    return fDirSegment === dirSegment || fBase === prefix;
  });

  if (similarFiles.length < 3) return null;

  // Check export style dominance
  const newStyle = getExportStyle(source);
  if (newStyle === "none" || newStyle === "mixed") return null;

  // We don't have source for index files, but we can rely on summary_path names being deterministic
  // For v1: compare count of similar files that match summary convention via naming heuristic
  // Use the index to check how many similar files use the same style convention
  // Since we only have the path info (no source), use path-based heuristic:
  // files in the same directory with the same extension share export style conventions
  // We detect divergence only when the new file uses "default" export while the directory
  // predominantly uses "named-const" (checked via index file metadata)

  // To check if divergence is significant: compare export style against index conventions
  // For v1 simple approach: check if pattern is inconsistent with the directory's established style
  // We derive this from the fact that in well-structured TS projects, directories tend to be consistent

  // Count how many existing similar files appear to use named const exports
  // (we infer from their paths and the convention that TS module files use named exports by default)
  const tsFiles = similarFiles.filter((f) => f.lang === "ts" || f.lang === "tsx");
  if (tsFiles.length < 3) return null;

  // The inconsistency we detect: new file uses "default" export while 80%+ of similar files
  // in the same dir use named-const (we approximate this from the dir having no index.ts re-exports
  // and from the convention that this codebase uses named-const exports throughout)

  // For a real signal, compare against explicit convention if detected
  // Here we use the simplest possible heuristic: if similar files exist and new file
  // uses "default" while the directory has established named-const pattern
  if (newStyle === "default") {
    // Check if similar files' paths suggest they don't use default exports
    // (approximated by their name patterns matching the naming convention)
    const kebabCount = tsFiles.filter((f) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(ts|tsx)$/.test(basename(f.path))).length;
    const ratio = kebabCount / tsFiles.length;

    if (ratio >= 0.8) {
      // Established named-const convention likely, new file uses default → flag
      return {
        rule_id: "repo-memory-inconsistency",
        tier: 1,
        severity: "low",
        file: filePath,
        line: 1,
        snippet: source.slice(0, 200),
        message: `Export style inconsistency: new file uses \`export default\` but ${tsFiles.length} similar file(s) in ${dir} appear to use named \`export const\` style.`,
        suggested_fix: "Use named exports (export const myRule = ...) to match established convention in this directory.",
      };
    }
  }

  return null;
}

export function makeInconsistencyRule(indexLoader: (memoryDir?: string) => Promise<RepoMemoryIndex | null> = loadIndex): RubricRule {
  return {
    id: "repo-memory-inconsistency",
    tier: 1,
    languages: ["ts", "tsx", "js", "jsx", "py"],
    async run(input: RubricInput): Promise<RubricRuleResult> {
      const t0 = performance.now();
      const triggers: RubricTrigger[] = [];

      const index = await indexLoader();
      if (!index) {
        return { rule_id: "repo-memory-inconsistency", triggers, duration_ms: performance.now() - t0 };
      }

      for (const file of input.changedFiles) {
        const trigger = await checkFile(file, index);
        if (trigger) triggers.push(trigger);
      }

      return { rule_id: "repo-memory-inconsistency", triggers, duration_ms: performance.now() - t0 };
    },
  };
}

export const repoMemoryInconsistencyRule: RubricRule = makeInconsistencyRule();
