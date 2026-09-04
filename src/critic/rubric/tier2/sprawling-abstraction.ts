// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricInput, RubricRule, RubricTrigger } from "../types";
import { parseSource } from "./ast-loader";

/**
 * sprawling-abstraction: new TS interface (or abstract class) that has exactly
 * 1 implementation + 1 caller across changedFiles. Signals premature abstraction.
 *
 * Only fires when the interface/abstract-class declaration appears in a diff-added
 * line range (i.e., it is newly introduced in this diff).
 */

// In-process regex counting instead of shelling out to `rg`. The previous
// implementation resolved a real ripgrep binary via a hardcoded Cursor.app
// path (macOS-only) with a bare "rg" fallback, silently caught any spawn
// failure, and returned 0. On any machine without Cursor.app AND without
// `rg` on PATH — every Linux CI runner, plus any Mac without Cursor
// installed — this rule silently produced ZERO triggers instead of erroring,
// so it never caught a real premature-abstraction violation there (verified:
// GitHub Actions ubuntu-latest does not ship ripgrep). The patterns this
// rule counts (`implements X`, `: X`, `import { X }`) are simple regexes
// over each file's source, read once via `contentCache` and shared with the
// tree-sitter parsing below — `countPattern` runs 3 patterns per new
// declaration over every changed TS/TSX file, so without the cache the same
// file would otherwise be re-read from disk repeatedly (3 × files × decls).
async function readCached(file: string, contentCache: Map<string, string>): Promise<string | null> {
  const cached = contentCache.get(file);
  if (cached !== undefined) return cached;
  try {
    const content = await readFile(file, "utf8");
    contentCache.set(file, content);
    return content;
  } catch {
    return null;
  }
}

async function countPattern(
  pattern: string,
  files: string[],
  contentCache: Map<string, string>,
): Promise<number> {
  if (files.length === 0) return 0;
  const re = new RegExp(pattern, "g");
  let total = 0;
  for (const file of files) {
    const content = await readCached(file, contentCache);
    if (content === null) continue;
    const matches = content.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

interface NewDeclaration {
  name: string;
  kind: "interface" | "abstract_class";
  file: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
  snippetLine: string;
}

function collectNewDeclarations(
  root: SyntaxNode,
  sourceLines: string[],
  filePath: string,
  addedLines: number[],
): NewDeclaration[] {
  const results: NewDeclaration[] = [];
  const addedSet = new Set(addedLines);

  function walk(node: SyntaxNode): void {
    if (node.type === "interface_declaration") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode?.text ?? "";
      if (name) {
        const startLine = node.startPosition.row + 1; // 1-based
        const endLine = node.endPosition.row + 1;
        // Only flag if the declaration overlaps with added lines
        const isNew = Array.from(addedSet).some(
          (ln) => ln >= startLine && ln <= endLine,
        );
        if (isNew) {
          results.push({
            name,
            kind: "interface",
            file: filePath,
            startLine,
            endLine,
            snippetLine: sourceLines[node.startPosition.row] ?? "",
          });
        }
      }
    }

    if (node.type === "class_declaration") {
      // Check for 'abstract' modifier
      const isAbstract = node.namedChildren.some(
        (c: SyntaxNode) => c.type === "abstract",
      );
      if (isAbstract) {
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text ?? "";
        if (name) {
          const startLine = node.startPosition.row + 1;
          const endLine = node.endPosition.row + 1;
          const isNew = Array.from(addedSet).some(
            (ln) => ln >= startLine && ln <= endLine,
          );
          if (isNew) {
            results.push({
              name,
              kind: "abstract_class",
              file: filePath,
              startLine,
              endLine,
              snippetLine: sourceLines[node.startPosition.row] ?? "",
            });
          }
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

export const sprawlingAbstractionRule: RubricRule = {
  id: "sprawling-abstraction",
  tier: 2,
  languages: ["ts", "tsx"],

  async run(input: RubricInput) {
    const t0 = performance.now();
    const triggers: RubricTrigger[] = [];

    // Collect TS/TSX files only
    const tsFiles = input.changedFiles.filter((f) => {
      const ext = f.split(".").pop()?.toLowerCase();
      return ext === "ts" || ext === "tsx";
    });

    if (tsFiles.length === 0) {
      return { rule_id: "sprawling-abstraction", triggers, duration_ms: performance.now() - t0 };
    }

    // Build a map of added lines per file from diffHunks
    const addedLinesMap = new Map<string, number[]>();
    for (const hunk of input.diffHunks) {
      // Match against full path or suffix
      const matchedFile = tsFiles.find(
        (f) => f === hunk.file || f.endsWith(hunk.file) || hunk.file.endsWith(f),
      );
      if (matchedFile) {
        const existing = addedLinesMap.get(matchedFile) ?? [];
        addedLinesMap.set(matchedFile, existing.concat(hunk.addedLines));
      }
    }

    // Find all newly added interface / abstract class declarations
    const newDecls: NewDeclaration[] = [];
    // Shared with countPattern below so each changed file is read from disk
    // at most once per run, regardless of how many patterns/declarations
    // scan it.
    const contentCache = new Map<string, string>();

    for (const file of tsFiles) {
      const addedLines = addedLinesMap.get(file) ?? [];
      if (addedLines.length === 0) continue; // No additions in this file

      const source = await readCached(file, contentCache);
      if (source === null) continue;

      const ext = file.split(".").pop()?.toLowerCase() as "ts" | "tsx";
      const tree = await parseSource(source, ext);
      if (!tree) continue;

      const lines = source.split("\n");
      const decls = collectNewDeclarations(
        tree.rootNode,
        lines,
        file,
        addedLines,
      );
      newDecls.push(...decls);
    }

    // For each new declaration, count implementations and callers across changedFiles
    for (const decl of newDecls) {
      const name = decl.name;

      // Count `implements Name` references (implementations)
      const implPattern = `implements\\s+${name}\\b`;
      const implCount = await countPattern(implPattern, tsFiles, contentCache);

      if (implCount !== 1) continue; // only flag exactly-1-impl

      // Count type annotation references: `: Name` and `import { Name }`
      // We count unique callers, not total references
      const callerPattern = `:\\s*${name}\\b`;
      const importPattern = `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`;

      const callerCount = await countPattern(callerPattern, tsFiles, contentCache);
      const importCount = await countPattern(importPattern, tsFiles, contentCache);

      // A caller file would have both an import + a `: Name` annotation
      // We use the min of the two as a conservative estimate of caller files
      // But since rg --count-matches counts occurrences not files, we use a simpler approach:
      // if total `: Name` references minus the impl file itself == 1, it's 1 caller
      // The impl file will have `: Name` if it uses the type itself, but primarily `implements Name`
      // Use import count as a proxy: 1 import in impl + 1 import in caller = 2
      // impl only counts if it also uses it as a type
      // Simpler: just count total callerPattern hits; if exactly 1, that's 1 call site
      const totalRefs = callerCount;
      if (totalRefs !== 1) continue;

      // Also require at least 1 import reference (otherwise it might be same-file usage)
      if (importCount < 1) continue;

      triggers.push({
        rule_id: "sprawling-abstraction",
        tier: 2 as const,
        severity: "high",
        file: decl.file,
        line: decl.startLine,
        end_line: decl.endLine,
        snippet: decl.snippetLine,
        message:
          `New ${decl.kind === "interface" ? "interface" : "abstract class"} '${name}' has exactly 1 implementation and 1 call site. ` +
          "This may be premature abstraction — consider using a concrete class directly until a second implementation is needed.",
        suggested_fix:
          "Remove the interface and use the concrete type directly. Re-introduce the abstraction (YAGNI principle) when you genuinely need a second implementation.",
      });
    }

    return {
      rule_id: "sprawling-abstraction",
      triggers,
      duration_ms: performance.now() - t0,
    };
  },
};
