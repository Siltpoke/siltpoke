// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Disk-awareness shared substrate: `importersOf`.
 *
 * Given a list of changed files, finds their runtime importers by scanning the
 * live filesystem (batched ripgrep by basename) and confirming each raw hit
 * against `resolveImportTarget` (tier-1–3, no `anchorMap`, no stored-index
 * dependency — the resolver's file-path index is built fresh from disk).
 *
 * Fail-soft by construction: every external call (ripgrep, listFiles, resolver)
 * is wrapped in `safe()`. A failure degrades the result (`degraded: true`,
 * empty importers) — this module never throws.
 *
 * "Counts as a runtime importer" requires BOTH:
 *   1. the raw line to sit in a runtime import position (static ESM import,
 *      export-from, CJS require, dynamic import) — NOT `import type`/`export type`
 *      (single- OR multi-line — see `TYPE_ONLY_BLOCK`), NOT a bare string literal
 *      that merely happens to contain the basename;
 *   2. the resolver to confirm the extracted specifier resolves to the exact
 *      changed file (`sameFile`) — same-basename decoys in a different
 *      directory are dropped here, not by the basename prefilter (which is
 *      deliberately loose, see `specCouldTarget`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveImportTarget } from "../../repo-graph/import-resolver";
import { getRgBin } from "../tools/rg-bin";

export interface ImportersResult {
  importers: string[];
  truncated: boolean;
  degraded: boolean;
}

export interface ImportersDeps {
  ripgrep?: (args: string[], cwd: string) => { code: number; stdout: string };
  resolver?: (src: string, rawTarget: string, idx: Set<string>) => string | null;
  /** Fresh repo-relative file paths (disk, not stored graph). */
  listFiles?: (cwd: string) => string[];
  /**
   * Reads a CANDIDATE importer file's full text, for multi-line `import type`
   * detection (see `TYPE_ONLY_BLOCK`). Only called for files that already
   * survived the single-line real-hit filter — bounded by MAX_CANDIDATES, not
   * the whole repo. A throw is fail-soft (treated as "no type-only blocks
   * found", i.e. the pre-fix over-count behavior for that one file only).
   */
  readFile?: (file: string, cwd: string) => string;
}

/** Raw ripgrep hits resolved per changed file (cap applied before resolver calls). */
export const MAX_CANDIDATES = 60;
/** Confirmed importers emitted per changed file. */
export const MAX_RESULTS = 20;

// A runtime import position: static ESM import, export-from, CJS require, dynamic import.
// The `\}\s*from\b` alt also catches the CLOSING line of a Biome-wrapped multi-line
// import/export (`import {\n  x,\n} from "./foo";`) — rg only returns the physical line
// containing the basename, which for a 2+-binding import is this closing line, not the
// opening `import {`. Deliberately NOT anchored with `^\s*` (fix G): Biome also emits the
// LAST specifier on the same line as the closing brace (`  baz } from "./foo";`), which a
// `^\s*\}` anchor would miss — dropping a genuine importer (a false NEGATIVE). A non-import
// line that merely contains `} from` is still discarded downstream because `extractSpec`
// requires a quoted module specifier after `from` (SPEC), so `isRealHit` rejects it
// (spec === null). Without this alt, importersOf silently under-detects a large share of
// this codebase's own imports (Biome's default wrap for named-import lists; 167+ instances
// across src/ at authoring time) — the false NEGATIVE it prevents is worse than the residual
// false POSITIVE it can't fully avoid (see TYPE_ONLY note).
const IMPORT_LINE = /\b(?:import\b|export\b[^;]*\bfrom\b|require\s*\(|import\s*\()|\}\s*from\b/;
// `isClosingBraceOnly`: a hit whose raw line is ONLY the closing tail of a wrapped statement
// (`...} from '<spec>';`, carrying NO `import`/`export`/`require` keyword of its OWN on the
// line) is AMBIGUOUS — rg saw just the tail of a wrapped multi-line statement, and this one
// physical line can't say whether the statement was `import {...}` (runtime) or `import type
// {...}` (type-only). Used below to scope the type-only-block filter to ONLY these ambiguous
// hits — a hit carrying its own import keyword already confirmed itself as real runtime on its
// own single line (see TYPE_ONLY) and must never be second-guessed by what some OTHER import
// in the same file does. NB (fix G): this must also recognize the trailing-specifier closing
// line (`baz } from '<spec>'`), so the OWN-keyword test — not a leading `^\s*}` anchor — is
// what separates a complete single-line import from a mere continuation tail.
const CLOSING_TAIL = /\}\s*from\b/;
const OWN_IMPORT_KEYWORD = /\b(?:import|export|require)\b/;
function isClosingBraceOnly(raw: string): boolean {
  return CLOSING_TAIL.test(raw) && !OWN_IMPORT_KEYWORD.test(raw);
}
// `import type` / `export type` on a SINGLE line — type-only, not runtime coverage. This
// alone is not enough: a Biome-wrapped multi-line `import type {\n  X,\n} from "./foo";` is
// invisible here because rg (and IMPORT_LINE's closing-brace alt above) only see the closing
// `} from` line, not the `import type {` opening line two lines up. Kept as a cheap
// single-line pass; `TYPE_ONLY_BLOCK` below catches the multi-line case it misses.
const TYPE_ONLY = /\b(?:import|export)\s+type\b/;
// Multi-line-capable companion to TYPE_ONLY: matches a whole `import type {...} from
// '<spec>'` / `export type {...} from '<spec>'` block against a CANDIDATE FILE'S FULL TEXT
// (not a single rg hit line) — JS regex character classes (`[^}]`, `[^'"]`) span newlines
// natively, with no special multiline/dotall flag needed, so this reaches the Biome-wrapped
// multi-line case a single rg hit line structurally cannot see (rg only returns the physical
// line containing the basename match, i.e. the closing `} from` line for a 2+-binding
// import). Deliberately narrow — named-import `{...}` form only, matching how Biome wraps
// this codebase's own imports — not a full parser. By itself this would over-exclude a file
// that imports the same spec BOTH type-only and at runtime (e.g. `import { b } from './x';
// import type { A } from './x';` — tests/memory/consolidate.test.ts:8-9's real pattern,
// ~6.3% of test files at authoring time); `importersOf` below pairs this with
// CLOSING_BRACE_ONLY so a confirmed single-line runtime hit is never excluded just because
// the same file also has a type-only import of the same spec.
const TYPE_ONLY_BLOCK = /(?:import|export)\s+type\s*\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/g;
// Inline type specifiers (TS 4.5): `import { type Foo } from '<spec>'` — the `type` keyword sits
// INSIDE the braces, so neither TYPE_ONLY (keyword BEFORE the brace) nor TYPE_ONLY_BLOCK sees it.
// A named import whose specifiers are ENTIRELY type-prefixed is type-only coverage (zero runtime),
// exactly like `import type {...}` — and a NEW source file whose only disk "test" imports it purely
// via `{ type X }` must NOT be treated as covered (that would be the cardinal silent false-negative).
// A MIXED import (`import { type A, b }`) keeps a runtime binding `b`, so it STILL counts. Matching
// the whole named-import block (single- OR multi-line: `[^}]` spans newlines natively) lets
// `allSpecifiersAreType` inspect every specifier before excluding.
const INLINE_NAMED_BLOCK = /(?:import|export)\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
// Single-line form, for the per-hit filter in isRealHit (a complete inline-type import on one line).
const INLINE_NAMED_LINE = /(?:import|export)\s*\{([^}]*)\}\s*from/;

// True when EVERY specifier inside a named-import brace carries a `type ` prefix (inline type-only).
// A binding literally named `type` (`import { type } from`) has no trailing word, so `/^type\s+\S/`
// treats it as runtime — the safe direction. The rare `import { type as Foo }` (renaming a binding
// named `type`) over-matches to type-only → over-fires ② (false POSITIVE, safe), never suppresses.
function allSpecifiersAreType(inner: string): boolean {
  const specs = inner.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
  if (specs.length === 0) return false;
  return specs.every((x) => /^type\s+\S/.test(x));
}

function isAllInlineTypeLine(raw: string): boolean {
  const m = INLINE_NAMED_LINE.exec(raw);
  return m?.[1] !== undefined && allSpecifiersAreType(m[1]);
}
// scope:"tests" ranking — a real test file, not a helpers/fixtures/mocks dir.
const TEST_GLOB = /(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests__\/)/i;
// Cover every accepted test-dir spelling (fix A): `tests/`, singular `test/`, and `__tests__/` —
// a `test/helpers/x.ts` (singular) or `__tests__/helpers/x.ts` importer must be excluded too, or a
// helper miscounts as a real test and SUPPRESSES a genuinely-untested new file (unsafe false-neg).
const NON_TEST_DIR = /(^|\/)(tests?|__tests__)\/(helpers|fixtures|mocks)\//i;
const EXCLUDED_DIR = /(^|\/)(node_modules|dist|docs)\//i;
// Parse an rg "-n" line into EXACTLY three groups so code lines with ':' (ternary `a ? b : c`,
// `x: string`, Windows paths) can't misalign path/line/content.
const HIT = /^(.*?):(\d+):(.*)$/;
// A quoted module specifier immediately after `from`, `require(`, `import(`, or a
// line-leading `import` (side-effect import) — this is what excludes a bare string
// literal, since a non-import line was already dropped by IMPORT_LINE.
const SPEC = /(?:from\s+|require\s*\(\s*|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/;

interface ParsedHit {
  file: string;
  raw: string;
  spec: string | null;
}
interface Hit {
  file: string;
  raw: string;
  spec: string;
}

function canon(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function baseNoExt(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py)$/i, "");
}

function extractSpec(line: string): string | null {
  const m = SPEC.exec(line);
  return m ? (m[1] ?? null) : null;
}

function isExcluded(file: string): boolean {
  return EXCLUDED_DIR.test(file);
}

function isRealHit(h: ParsedHit): h is Hit {
  return (
    h.spec !== null &&
    IMPORT_LINE.test(h.raw) &&
    !TYPE_ONLY.test(h.raw) &&
    !isAllInlineTypeLine(h.raw) && // fix B: a complete single-line `import { type X } from '<spec>'`
    !isExcluded(h.file)
  );
}

/** All `import type`/`export type {...} from '<spec>'` specs found in a file's full text
 * (single- or multi-line, since the regex spans newlines natively — see `TYPE_ONLY_BLOCK`). */
function typeOnlySpecsIn(content: string): Set<string> {
  const specs = new Set<string>();
  for (const m of content.matchAll(TYPE_ONLY_BLOCK)) {
    const spec = m[2];
    if (spec) specs.add(spec);
  }
  // Inline-type form (fix B): a named-import block whose specifiers are ALL type-prefixed.
  for (const m of content.matchAll(INLINE_NAMED_BLOCK)) {
    if (m[1] !== undefined && m[3] && allSpecifiersAreType(m[1])) specs.add(m[3]);
  }
  return specs;
}

// Cheap prefilter (basename match) so `resolve` only runs on plausible hits — deliberately
// loose: the real confirmation is `sameFile` after resolution, not this. Handles the common
// directory/index-import case (`./a` -> `src/a/index.ts`) as well as a direct basename match.
function specCouldTarget(spec: string, cf: string): boolean {
  const specBase = baseNoExt(spec);
  if (specBase === "") return false;
  const cfBase = baseNoExt(cf);
  if (specBase === cfBase) return true;
  if (/^(index|__init__)$/i.test(cfBase)) {
    const cfDir = cf.split("/").slice(-2, -1)[0] ?? "";
    return cfDir !== "" && cfDir === specBase;
  }
  return false;
}

// The confirmation the mutation check targets: a candidate only counts as an importer of
// `cf` when its resolved target canonicalizes to the exact same file — same-basename
// decoys in a different directory must NOT pass.
function sameFile(target: string, cf: string): boolean {
  return canon(target) === cf;
}

/** ripgrep argv for a batched, multi-basename `-e` search (no path — cwd carries that). */
export function rgArgs(basenames: string[]): string[] {
  // `--fixed-strings` (fix D): a basename like `[id]`, `foo+bar`, or `$schema` carries regex
  // metacharacters — as a regex `-e` pattern it either misses the real importer line (`foo+bar`
  // ⇒ `fo+bar`, `$schema` ⇒ end-anchor) or explodes the hit set (`[id]` ⇒ any of i/d). `-F`
  // matches the basename literally. `rg --files` (listFiles) takes no pattern, so it is unaffected.
  const args = ["--no-heading", "--line-number", "--no-messages", "--fixed-strings"];
  for (const b of basenames) args.push("-e", b);
  return args;
}

function defaultRipgrep(args: string[], cwd: string): { code: number; stdout: string } {
  const proc = Bun.spawnSync([getRgBin(), ...args], { cwd });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

function defaultListFiles(cwd: string): string[] {
  const proc = Bun.spawnSync([getRgBin(), "--files"], { cwd });
  if ((proc.exitCode ?? 1) > 1) return [];
  return proc.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
}

function defaultReadFile(file: string, cwd: string): string {
  return readFileSync(join(cwd, file), "utf-8");
}

/**
 * Find the runtime importers of `changedFiles` by scanning disk (fresh ripgrep +
 * fresh file index — no stored-graph dependency), confirmed against
 * `resolveImportTarget` (tier-1–3, no anchorMap). Never throws.
 *
 * `scope: "imports"` returns any confirmed importer; `scope: "tests"` further
 * ranks candidates down to real test files (excludes tests/helpers|fixtures|mocks).
 */
export function importersOf(
  changedFiles: string[],
  opts: { cwd: string; scope: "imports" | "tests"; deps?: ImportersDeps },
): Map<string, ImportersResult> {
  const out = new Map<string, ImportersResult>();
  const deps = opts.deps ?? {};
  const resolve =
    deps.resolver ?? ((s: string, t: string, i: Set<string>) => resolveImportTarget(s, t, i));
  const keyed = changedFiles.map(canon);
  for (const cf of keyed) out.set(cf, { importers: [], truncated: false, degraded: false });

  // Fresh disk file index. FAIL-OPEN (fix E-1): a THROW (rg --files missing/exploded) OR an
  // empty index for a NON-empty changed-files set means the lookup cannot be trusted — degrade
  // EVERY result so ② abstains instead of firing off a broken/empty index. An empty repo would
  // have no changed files, so empty-for-nonempty is always an infra failure, never a valid answer.
  const listed = safe(
    () => (deps.listFiles ?? defaultListFiles)(opts.cwd),
    null as string[] | null,
  );
  if (listed === null || (listed.length === 0 && keyed.length > 0)) {
    for (const r of out.values()) r.degraded = true;
    return out;
  }
  const idx = new Set(listed.map(canon));

  // ONE batched ripgrep across all basenames.
  const basenames = [...new Set(keyed.map(baseNoExt))].filter((b) => b.length > 0);
  const rg = safe(() => (deps.ripgrep ?? defaultRipgrep)(rgArgs(basenames), opts.cwd), null);
  if (!rg || rg.code > 1) {
    for (const r of out.values()) r.degraded = true;
    return out;
  }

  // Parse ALL hits once, GROUP BY the changed file each hit could belong to BEFORE any per-file
  // cap — a global slice() would starve later files behind a common basename.
  const parsed: ParsedHit[] = rg.stdout
    .split("\n")
    .map((l) => HIT.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: canon(m[1] ?? ""), raw: m[3] ?? "", spec: extractSpec(m[3] ?? "") }));
  const allHits: Hit[] = parsed.filter(isRealHit);

  // Multi-line `import type` block filter (see TYPE_ONLY_BLOCK docblock). Only reads the
  // FULL TEXT of files that already survived the single-line real-hit filter above — bounded
  // by candidate volume, not the whole repo. Cached per-file since multiple hits can share an
  // importer file. A read failure is fail-soft: that file's hits stay in the pre-fix
  // over-count posture (safe direction — over-inclusion, not a silent miss) rather than
  // aborting the whole lookup.
  const readFile = deps.readFile ?? defaultReadFile;
  const typeOnlyCache = new Map<string, Set<string>>();
  const typeOnlySpecsFor = (file: string): Set<string> => {
    const cached = typeOnlyCache.get(file);
    if (cached) return cached;
    const specs = safe(() => typeOnlySpecsIn(readFile(file, opts.cwd)), new Set<string>());
    typeOnlyCache.set(file, specs);
    return specs;
  };
  // Bounded refinement (round 2): only exclude a (file, spec) pair when it has a type-only
  // block AND no CONFIRMED runtime import of the same spec in the same file. Without this, a
  // file that imports the same module both type-only and at runtime — e.g.
  // `import { consolidate, ... } from '<spec>'` + `import type { ConsolidateOpts } from
  // '<spec>'`, tests/memory/consolidate.test.ts:8-9's real pattern, ~6.3% of test files at
  // authoring time — had ALL of its hits for that spec dropped, including the genuine
  // runtime one (a live false-fire risk on ~41 actually-tested files).
  //
  // "Confirmed runtime" = a hit whose raw line is a COMPLETE import/export/require/dynamic-
  // import on ONE line (not merely the `^\s*}\s*from\b` closing-brace continuation of a
  // wrapped statement). Such a hit already passed the single-line TYPE_ONLY check in
  // isRealHit on its own merits, so it unambiguously confirms a real runtime import —
  // independent of whatever ELSE the file imports. A closing-brace-only hit carries no such
  // guarantee: rg only saw the line `} from '<spec>';`, which is structurally identical
  // whether the wrapped statement was `import {...}` (runtime) or `import type {...}`
  // (type-only) — that's the genuinely ambiguous case TYPE_ONLY_BLOCK exists to resolve.
  //
  // Residual NOT covered: a file where the RUNTIME import of a shared spec is ALSO wrapped
  // multi-line (so its own hit is closing-brace-only, with no complete-line hit to confirm
  // it) — that narrower case still has no unambiguous signal and stays excluded. Requires
  // both statements to reference the exact same spec AND the runtime side specifically to
  // be Biome-wrapped; not observed among the 41 files driving this fix.
  const confirmedRuntimePairs = new Set(
    allHits.filter((h) => !isClosingBraceOnly(h.raw)).map((h) => `${h.file} ${h.spec}`),
  );
  const realHits: Hit[] = allHits.filter((h) => {
    if (!isClosingBraceOnly(h.raw)) return true; // complete on-one-line import — never ambiguous
    if (!typeOnlySpecsFor(h.file).has(h.spec)) return true; // no type-only block for this spec here
    return confirmedRuntimePairs.has(`${h.file} ${h.spec}`); // keep iff a confirmed runtime hit exists too
  });

  for (const cf of keyed) {
    const r = out.get(cf);
    if (!r) continue;
    let candidates = realHits.filter((h) => h.file !== cf && specCouldTarget(h.spec, cf));
    if (opts.scope === "tests") {
      // rank real test files, drop helpers/fixtures/mocks
      candidates = candidates.filter((h) => TEST_GLOB.test(h.file) && !NON_TEST_DIR.test(h.file));
    }
    if (candidates.length > MAX_CANDIDATES) {
      candidates = candidates.slice(0, MAX_CANDIDATES);
      r.truncated = true;
    }
    for (const h of candidates) {
      // FAIL-OPEN (fix E-2): distinguish a resolver THROW (infra failure — can't trust this
      // changed file's verdict) from a clean `null` (resolved fine, just doesn't target cf — a
      // valid answer). A throw degrades ONLY this file's result so ② abstains rather than firing
      // off a failed resolver; a clean null keeps searching the remaining candidates.
      let target: string | null;
      try {
        target = resolve(h.file, h.spec, idx);
      } catch {
        r.degraded = true;
        break;
      }
      if (target && sameFile(target, cf) && !r.importers.includes(h.file)) {
        r.importers.push(h.file);
      }
      if (r.importers.length >= MAX_RESULTS) {
        r.truncated = true;
        break;
      }
    }
  }
  return out;
}
