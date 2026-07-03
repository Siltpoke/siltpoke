#!/usr/bin/env bun
// File-length cap (primary north-star metric).
//
// Threshold: <400 LOC typical (warn), <800 LOC max (error).
// Configurable via SILTPOKE_FILE_WARN + SILTPOKE_FILE_MAX env vars.
//
// Ratchet: files listed in .lint-files-grandfather.json are warn-only
// at the 400 threshold (one-way ratchet — additions require reviewer
// sign-off). Any NEW file >400 LOC that isn't on the list is an ERROR.
//
// Scans src/, tests/, scripts/ — total raw line count per file (no AST,
// quick wall-clock). Reports sorted descending.

import { Glob } from "bun";
import { readFile } from "node:fs/promises";

const WARN = Number(process.env.SILTPOKE_FILE_WARN ?? 400);
const MAX = Number(process.env.SILTPOKE_FILE_MAX ?? 800);
const ROOTS = ["src", "tests", "scripts"];
const GRANDFATHER_FILE = ".lint-files-grandfather.json";

interface GrandfatherFile {
  files: string[];
}

let grandfather: Set<string> = new Set();
try {
  const raw = await readFile(GRANDFATHER_FILE, "utf8");
  const parsed = JSON.parse(raw) as GrandfatherFile;
  grandfather = new Set(parsed.files);
} catch {
  // No grandfather file — strict mode (every >400 file is an error).
}

type Row = { file: string; lines: number };
const rows: Row[] = [];

for (const root of ROOTS) {
  for await (const file of new Glob(`${root}/**/*.{ts,tsx}`).scan(".")) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n").length;
    rows.push({ file, lines });
  }
}

rows.sort((a, b) => b.lines - a.lines);

const overMax = rows.filter((r) => r.lines > MAX);
const overWarnNotGrandfathered = rows.filter((r) => r.lines > WARN && r.lines <= MAX && !grandfather.has(r.file));
const overWarnGrandfathered = rows.filter((r) => r.lines > WARN && r.lines <= MAX && grandfather.has(r.file));

const errs = [...overMax, ...overWarnNotGrandfathered];

console.log(`lint:files — ${rows.length} files scanned`);
console.log(`  threshold: warn >${WARN}, error >${MAX}`);
console.log(`  grandfather list: ${grandfather.size} files (warn-only at ${WARN}–${MAX} LOC)`);
console.log(`  result: ${errs.length} errors, ${overWarnGrandfathered.length} grandfathered warnings`);

if (overMax.length > 0) {
  console.error(`\nERROR — ${overMax.length} file(s) exceed ${MAX} LOC:`);
  for (const r of overMax) console.error(`  ${r.lines.toString().padStart(5)}  ${r.file}`);
}

if (overWarnNotGrandfathered.length > 0) {
  console.error(`\nERROR — ${overWarnNotGrandfathered.length} NEW file(s) exceed ${WARN} LOC (not on grandfather list):`);
  for (const r of overWarnNotGrandfathered) console.error(`  ${r.lines.toString().padStart(5)}  ${r.file}`);
  console.error(`\n  To grandfather, add to ${GRANDFATHER_FILE} (requires reviewer sign-off — one-way ratchet).`);
  console.error(`  Better: split the file below ${WARN} LOC.`);
}

if (overWarnGrandfathered.length > 0) {
  console.warn(`\nWARN — ${overWarnGrandfathered.length} grandfathered file(s) exceed ${WARN} LOC:`);
  for (const r of overWarnGrandfathered.slice(0, 30)) console.warn(`  ${r.lines.toString().padStart(5)}  ${r.file}`);
  if (overWarnGrandfathered.length > 30) console.warn(`  ... and ${overWarnGrandfathered.length - 30} more.`);
}

const pctUnderWarn = ((rows.length - overWarnNotGrandfathered.length - overWarnGrandfathered.length - overMax.length) / rows.length) * 100;
console.log(`\nnorth-star: ${pctUnderWarn.toFixed(1)}% of files <${WARN} LOC (target 95%)`);

process.exit(errs.length > 0 ? 1 : 0);
