#!/usr/bin/env bun
// File-length cap (primary north-star metric).
//
// Threshold: <400 LOC typical (warn), <800 LOC max (error).
// Configurable via SILTPOKE_FILE_WARN + SILTPOKE_FILE_MAX env vars.
//
// Ratchet: .lint-files-grandfather.json pins each grandfathered file at the
// size it had when it was frozen. Going OVER that pin is an error at any
// size — including above MAX, which the old list could not cover, so 28 files
// >800 LOC were permanent errors and the whole gate was left informational.
// A file not on the list is an error over WARN. `--capture` re-pins every
// current offender (that is also how the list shrinks: split a file, re-pin).
//
// The rule this encodes: existing debt is frozen, new debt is red.
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
  /** path -> the line count this file is pinned at. */
  pinned?: Record<string, number>;
  /** Pre-2026-09 shape: a bare list, read as "pinned at MAX". */
  files?: string[];
}

const CAPTURE = process.argv.includes("--capture");
let pinned = new Map<string, number>();
try {
  const raw = await readFile(GRANDFATHER_FILE, "utf8");
  const parsed = JSON.parse(raw) as GrandfatherFile;
  if (parsed.pinned) {
    pinned = new Map(Object.entries(parsed.pinned));
  } else if (parsed.files) {
    pinned = new Map(parsed.files.map((f) => [f, MAX]));
  }
} catch {
  // No grandfather file — strict mode (every >WARN file is an error).
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

if (CAPTURE) {
  const offenders = rows.filter((r) => r.lines > WARN);
  const next: Record<string, number> = {};
  for (const r of [...offenders].sort((a, b) => a.file.localeCompare(b.file))) next[r.file] = r.lines;
  await Bun.write(
    GRANDFATHER_FILE,
    `${JSON.stringify(
      {
        _description:
          "File-length ratchet. Each entry pins a file at the size it was frozen at: going OVER the pin is an error, at any size. A file not listed here is an error over the 400-LOC threshold. Shrink a file and re-run with --capture to lower its pin; that is the only direction this list is meant to move.",
        _locked_at: new Date().toISOString().slice(0, 10),
        pinned: next,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`captured ${offenders.length} file(s) to ${GRANDFATHER_FILE}`);
  process.exit(0);
}

/** Over its own pin (grandfathered), or over WARN with no pin at all. */
const grew = rows.filter((r) => {
  const pin = pinned.get(r.file);
  return pin !== undefined && r.lines > pin;
});
const overWarnNotGrandfathered = rows.filter((r) => r.lines > WARN && !pinned.has(r.file));
const overMax = rows.filter((r) => r.lines > MAX && !pinned.has(r.file));
const overWarnGrandfathered = rows.filter((r) => r.lines > WARN && pinned.has(r.file) && r.lines <= (pinned.get(r.file) ?? 0));

const errs = [...grew, ...overWarnNotGrandfathered];

console.log(`lint:files — ${rows.length} files scanned`);
console.log(`  threshold: warn >${WARN}, error >${MAX}`);
console.log(`  pinned: ${pinned.size} file(s) frozen at their current size (over the pin = error)`);
console.log(`  result: ${errs.length} errors, ${overWarnGrandfathered.length} grandfathered warnings`);

if (grew.length > 0) {
  console.error(`\nERROR — ${grew.length} grandfathered file(s) grew past their pin:`);
  for (const r of grew) console.error(`  ${r.lines.toString().padStart(5)}  ${r.file} (pinned at ${pinned.get(r.file)})`);
  console.error(`\n  Bring it back under the pin, or split it. Raising a pin is debt, not maintenance.`);
}

if (overMax.length > 0) {
  console.error(`\nERROR — ${overMax.length} unpinned file(s) exceed ${MAX} LOC:`);
  for (const r of overMax) console.error(`  ${r.lines.toString().padStart(5)}  ${r.file}`);
}

if (overWarnNotGrandfathered.length > 0) {
  console.error(`\nERROR — ${overWarnNotGrandfathered.length} NEW file(s) exceed ${WARN} LOC (not on grandfather list):`);
  for (const r of overWarnNotGrandfathered) console.error(`  ${r.lines.toString().padStart(5)}  ${r.file}`);
  console.error(`\n  To grandfather, add to ${GRANDFATHER_FILE} (requires reviewer sign-off — one-way ratchet).`);
  console.error(`  Better: split the file below ${WARN} LOC.`);
}

if (overWarnGrandfathered.length > 0) {
  console.warn(`\nWARN — ${overWarnGrandfathered.length} pinned file(s) over ${WARN} LOC (frozen, not growing):`);
  for (const r of overWarnGrandfathered.slice(0, 30)) console.warn(`  ${r.lines.toString().padStart(5)}  ${r.file}`);
  if (overWarnGrandfathered.length > 30) console.warn(`  ... and ${overWarnGrandfathered.length - 30} more.`);
}

const pctUnderWarn = ((rows.length - overWarnNotGrandfathered.length - overWarnGrandfathered.length - overMax.length) / rows.length) * 100;
console.log(`\nnorth-star: ${pctUnderWarn.toFixed(1)}% of files <${WARN} LOC (target 95%)`);

process.exit(errs.length > 0 ? 1 : 0);
