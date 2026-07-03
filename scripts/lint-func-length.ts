#!/usr/bin/env bun
// Function-length cap.
//
// Cap = 50 LOC per function (Airbnb mainstream), counting code lines only
// (blank lines + comments skipped). Configurable via SILTPOKE_FUNC_MAX env var.
//
// Walks src/, tests/, scripts/ via ts-morph AST. Reports per-function violations
// and exits non-zero if any function exceeds the cap.

import { Project, type Node, SyntaxKind } from "ts-morph";
import { join } from "node:path";

const MAX = Number(process.env.SILTPOKE_FUNC_MAX ?? 50);
const ROOTS = ["src", "tests", "scripts"];
const IGNORE_GLOBS = [
  "**/*.golden.test.ts",
  "**/*.golden.test.tsx",
  "src/cli/report-i18n/**",
];

type Violation = { file: string; line: number; name: string; loc: number };

function isFunctionLike(node: Node): boolean {
  const k = node.getKind();
  return (
    k === SyntaxKind.FunctionDeclaration ||
    k === SyntaxKind.FunctionExpression ||
    k === SyntaxKind.ArrowFunction ||
    k === SyntaxKind.MethodDeclaration ||
    k === SyntaxKind.Constructor ||
    k === SyntaxKind.GetAccessor ||
    k === SyntaxKind.SetAccessor
  );
}

function functionName(node: Node): string {
  if ("getName" in node && typeof (node as { getName?: () => string }).getName === "function") {
    const n = (node as { getName: () => string | undefined }).getName();
    if (n) return n;
  }
  const parent = node.getParent();
  if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) {
    return (parent as unknown as { getName: () => string }).getName();
  }
  if (parent && parent.getKind() === SyntaxKind.PropertyAssignment) {
    return (parent as unknown as { getName: () => string }).getName();
  }
  return "<anonymous>";
}

function codeLineCount(body: string): number {
  const lines = body.split("\n");
  let count = 0;
  let inBlockComment = false;
  for (const raw of lines) {
    let line = raw.trim();
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end >= 0) {
        line = line.slice(end + 2).trim();
        inBlockComment = false;
      } else {
        continue;
      }
    }
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/");
      if (end < 0) {
        inBlockComment = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (line.length === 0) continue;
    count++;
  }
  return count;
}

const project = new Project({
  tsConfigFilePath: join(process.cwd(), "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});

for (const root of ROOTS) {
  project.addSourceFilesAtPaths([
    `${root}/**/*.ts`,
    `${root}/**/*.tsx`,
    ...IGNORE_GLOBS.map((g) => `!${g}`),
  ]);
}

const violations: Violation[] = [];

for (const sf of project.getSourceFiles()) {
  const file = sf.getFilePath();
  sf.forEachDescendant((node) => {
    if (!isFunctionLike(node)) return;
    const body = (node as unknown as { getBodyText?: () => string | undefined }).getBodyText?.();
    if (!body) return;
    const loc = codeLineCount(body);
    if (loc <= MAX) return;
    violations.push({
      file: file.replace(process.cwd() + "/", ""),
      line: node.getStartLineNumber(),
      name: functionName(node),
      loc,
    });
  });
}

violations.sort((a, b) => b.loc - a.loc);

if (violations.length === 0) {
  console.log(`lint:func — all functions ≤${MAX} LOC across ${project.getSourceFiles().length} files`);
  process.exit(0);
}

console.error(`lint:func — ${violations.length} function(s) exceed ${MAX} LOC cap (skip blanks + comments):\n`);
for (const v of violations.slice(0, 40)) {
  console.error(`  ${v.file}:${v.line} — ${v.name} (${v.loc} LOC)`);
}
if (violations.length > 40) {
  console.error(`  ... and ${violations.length - 40} more.`);
}

process.exit(1);
