#!/usr/bin/env bun
// Function-length cap.
//
// Cap = 50 LOC per function (Airbnb mainstream), counting code lines only
// (blank lines + comments skipped). Configurable via SILTPOKE_FUNC_MAX env var.
//
// Walks src/, tests/, scripts/ via ts-morph AST. Reports per-function violations
// and exits non-zero if any function exceeds the cap.
//
// Ratchet: .lint-func-baseline.json pins today's offenders — per (file, name),
// the largest size and how many there are. Over the pin, or a new offender, is
// an error; everything already there is frozen. Without this the gate reported
// 1062 violations, never passed, and was therefore never read. `--capture`
// re-pins, which is how the file shrinks once a function is actually split.

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

// ---------------------------------------------------------------- ratchet
const BASELINE_FILE = ".lint-func-baseline.json";
type Pin = { max: number; count: number };
const key = (v: Violation): string => `${v.file}:${v.name}`;

const current = new Map<string, Pin>();
for (const v of violations) {
  const seen = current.get(key(v));
  current.set(key(v), { max: Math.max(seen?.max ?? 0, v.loc), count: (seen?.count ?? 0) + 1 });
}

if (process.argv.includes("--capture")) {
  const pins: Record<string, Pin> = {};
  for (const k of [...current.keys()].sort()) pins[k] = current.get(k) as Pin;
  await Bun.write(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        _description:
          "Function-length ratchet. Each key is file:function pinned at its largest size and how many functions share that key. Over the pin, or a key not listed, is an error. Split a function and re-run with --capture to lower its pin; that is the only direction this file is meant to move.",
        _locked_at: new Date().toISOString().slice(0, 10),
        _cap: MAX,
        pins,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`captured ${Object.keys(pins).length} pinned key(s) (${violations.length} function(s)) to ${BASELINE_FILE}`);
  process.exit(0);
}

let pinned = new Map<string, Pin>();
try {
  const parsed = JSON.parse(await Bun.file(BASELINE_FILE).text()) as { pins?: Record<string, Pin> };
  pinned = new Map(Object.entries(parsed.pins ?? {}));
} catch {
  // No baseline — strict mode, every violation is an error.
}

const regressions: string[] = [];
for (const [k, cur] of current) {
  const pin = pinned.get(k);
  if (!pin) {
    regressions.push(`NEW  ${k} (${cur.max} LOC)`);
    continue;
  }
  if (cur.max > pin.max) regressions.push(`GREW ${k} (${cur.max} LOC, pinned at ${pin.max})`);
  if (cur.count > pin.count) regressions.push(`MORE ${k} (${cur.count}, pinned at ${pin.count})`);
}

if (pinned.size > 0) {
  console.log(
    `lint:func — ${violations.length} function(s) over ${MAX} LOC, ${pinned.size} key(s) pinned; ${regressions.length} regression(s)`,
  );
  if (regressions.length === 0) process.exit(0);
  console.error(`\nERROR — ${regressions.length} function-length regression(s):`);
  for (const r of regressions.slice(0, 40)) console.error(`  ${r}`);
  if (regressions.length > 40) console.error(`  ... and ${regressions.length - 40} more.`);
  console.error(`\n  Split the function, or re-run with --capture if it genuinely shrank elsewhere.`);
  process.exit(1);
}

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
