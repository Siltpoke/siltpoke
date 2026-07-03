// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Node as SyntaxNode } from "web-tree-sitter";
import type { RubricRule, RubricInput, RubricTrigger } from "../types";
import { parseSource } from "./ast-loader";

/**
 * sprawling-abstraction: new TS interface (or abstract class) that has exactly
 * 1 implementation + 1 caller across changedFiles. Signals premature abstraction.
 *
 * Only fires when the interface/abstract-class declaration appears in a diff-added
 * line range (i.e., it is newly introduced in this diff).
 */

// Prefer the Cursor-bundled rg binary which is always the real ripgrep,
// not a shell function wrapper (e.g. RTK or Claude Code hooks).
const CURSOR_RG =
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg";

function getRgBin(): string {
  if (process.env.RG_BIN_OVERRIDE) return process.env.RG_BIN_OVERRIDE;
  if (existsSync(CURSOR_RG)) return CURSOR_RG;
  return "rg";
}

// Ripgrep search using Bun.spawn directly
async function rgCount(pattern: string, files: string[]): Promise<number> {
  if (files.length === 0) return 0;

  const rgBin = getRgBin();

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [rgBin, "--count-matches", "--multiline", "-e", pattern, ...files],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return 0;
  }

  const exitCode = await proc.exited;
  // rg exits 1 when no matches (not an error)
  if (exitCode !== 0 && exitCode !== 1) return 0;

  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  // Each line is "file:count" — sum all counts
  let total = 0;
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    // Format: path:N or just N (single file)
    const parts = line.split(":");
    const countStr = parts[parts.length - 1];
    const n = parseInt(countStr ?? "0", 10);
    if (!Number.isNaN(n)) total += n;
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

    for (const file of tsFiles) {
      const addedLines = addedLinesMap.get(file) ?? [];
      if (addedLines.length === 0) continue; // No additions in this file

      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch {
        continue;
      }

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
      const implCount = await rgCount(implPattern, tsFiles);

      if (implCount !== 1) continue; // only flag exactly-1-impl

      // Count type annotation references: `: Name` and `import { Name }`
      // We count unique callers, not total references
      const callerPattern = `:\\s*${name}\\b`;
      const importPattern = `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`;

      const callerCount = await rgCount(callerPattern, tsFiles);
      const importCount = await rgCount(importPattern, tsFiles);

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
