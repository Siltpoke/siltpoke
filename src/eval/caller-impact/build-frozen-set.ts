// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Build the frozen eval set from REAL indexed repos.
 *
 * Each planted example: a signature-break diff of function F (file A) where F
 * has a REAL cross-file caller in an UNCHANGED file B (outside the diff). The
 * caller resolvers search the real repo for F's callers; the planted bug is the
 * broken call site in B. Clean controls (no planted bug) measure the FP floor.
 *
 * The pick data (repo roots + planted call sites) is MACHINE-LOCAL and lives
 * in `local-picks.json` next to this file — git-ignored, because it encodes
 * absolute paths and file structure of your own repos. The
 * schema is below (`LocalPicks`); to rebuild the set on a new machine, select
 * single-def functions with ≥1 cross-file caller in your own repos and write
 * the file by hand. Without it, this module (and INV2's drift re-derivation
 * in run-eval.ts) refuses with a clear error.
 *
 * The diff is a minimal real signature break (insert a required param into
 * F's def line), realistic context for the Brain; the catch oracle keys on
 * the caller in B.
 *
 * $0, deterministic. Run: `bun src/eval/caller-impact/build-frozen-set.ts`.
 * Writes frozen-manifest.json (all repos) + lean-manifest.json (the repo
 * marked `lean` — for the staged lean confirmatory run). Both outputs are
 * git-ignored for the same reason as the picks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EvalExample, freezeManifest } from "./manifest";

interface PlantedPick {
  id: string;
  repoKey: string;
  fn: string;
  fileA: string;
  defLine: number;
  callerFile: string;
  callerLine: number;
  wrongTarget: string;
}

interface ControlPick {
  id: string;
  repoKey: string;
  fileA: string;
  line: number;
}

interface LocalPicks {
  /** repoKey → absolute repo root on THIS machine. */
  repos: Record<string, string>;
  planted: PlantedPick[];
  controls: ControlPick[];
}

const PICKS_PATH = join(import.meta.dir, "local-picks.json");

function loadPicks(): LocalPicks {
  let raw: string;
  try {
    raw = readFileSync(PICKS_PATH, "utf8");
  } catch {
    throw new Error(
      `local-picks.json not found at ${PICKS_PATH} — the frozen-set pick data is machine-local ` +
        "(it encodes absolute paths into local repos) and is not committed. " +
        "See the header comment in build-frozen-set.ts for the schema.",
    );
  }
  const picks = JSON.parse(raw) as LocalPicks;
  for (const p of [...picks.planted, ...picks.controls]) {
    if (!(p.repoKey in picks.repos)) {
      throw new Error(`local-picks.json: pick "${p.id}" references unknown repoKey "${p.repoKey}"`);
    }
  }
  return picks;
}

function lineOf(repo: string, file: string, n: number): string {
  const lines = readFileSync(join(repo, file), "utf8").split("\n");
  return lines[n - 1] ?? "";
}

/** Minimal real signature break: insert a required param into F's def line. */
function sigBreakDiff(repo: string, file: string, defLine: number): string {
  const old = lineOf(repo, file, defLine);
  const close = old.indexOf(")");
  const neu =
    close >= 0
      ? `${old.slice(0, close)}${old.slice(0, close).trimEnd().endsWith("(") ? "" : ", "}evalBreakingParam: number${old.slice(close)}`
      : `${old} /* signature changed: +evalBreakingParam */`;
  return `--- a/${file}\n+++ b/${file}\n@@ -${defLine},1 +${defLine},1 @@\n-${old}\n+${neu}\n`;
}

/** A clean control diff: append a harmless trailing comment near a real line. */
function cleanDiff(repo: string, file: string, line: number): string {
  const ctx = lineOf(repo, file, line);
  return `--- a/${file}\n+++ b/${file}\n@@ -${line},1 +${line},2 @@\n ${ctx}\n+// eval clean-control: comment-only, no behavior change\n`;
}

function buildPlanted(repos: Record<string, string>, p: PlantedPick): EvalExample {
  const repo = repos[p.repoKey]!;
  return {
    id: p.id,
    repo,
    diff: sigBreakDiff(repo, p.fileA, p.defLine),
    plantedBug: { file: p.callerFile, function: `caller-of-${p.fn}`, line: p.callerLine },
    isControl: false,
    changedFunction: p.fn,
    wrongTarget: p.wrongTarget,
  };
}

function buildControl(repos: Record<string, string>, c: ControlPick): EvalExample {
  const repo = repos[c.repoKey]!;
  return {
    id: c.id,
    repo,
    diff: cleanDiff(repo, c.fileA, c.line),
    plantedBug: null,
    isControl: true,
  };
}

/**
 * Re-derive the full example set from the live repo source files. INV2 calls
 * this at run time and compares its content hash against the frozen manifest —
 * if a source file used by a diff changed since freeze, the hashes diverge and
 * the run refuses. (This is what makes the freeze guard non-vacuous: the runner
 * alone compares the manifest to itself, which can only catch hand-tampering.)
 */
export function buildAllExamples(): EvalExample[] {
  const picks = loadPicks();
  return [
    ...picks.planted.map((p) => buildPlanted(picks.repos, p)),
    ...picks.controls.map((c) => buildControl(picks.repos, c)),
  ];
}

if (import.meta.main) {
  const picks = loadPicks();
  const examples = buildAllExamples();
  const full = freezeManifest("phase-C-eval-1", examples);
  writeFileSync(join(import.meta.dir, "frozen-manifest.json"), `${JSON.stringify(full, null, 2)}\n`);

  // Lean set = the last repoKey's picks (staged confirmatory run on one repo).
  const leanKey = Object.keys(picks.repos).at(-1) ?? "";
  const leanIds = new Set([
    ...picks.planted.filter((p) => p.repoKey === leanKey).map((p) => p.id),
    ...picks.controls.filter((c) => c.repoKey === leanKey).map((c) => c.id),
  ]);
  const leanExamples = examples.filter((e) => leanIds.has(e.id));
  const lean = freezeManifest("phase-C-eval-1-lean", leanExamples);
  writeFileSync(join(import.meta.dir, "lean-manifest.json"), `${JSON.stringify(lean, null, 2)}\n`);

  process.stdout.write(
    `frozen-manifest.json: ${full.examples.length} examples (${picks.planted.length} planted, ${picks.controls.length} controls), hash ${full.contentHash.slice(0, 12)}\n` +
      `lean-manifest.json: ${lean.examples.length} examples (${leanKey}), hash ${lean.contentHash.slice(0, 12)}\n`,
  );
}
