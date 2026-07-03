// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { relative } from "node:path";
import { getRgBin } from "../tools/rg-bin.ts";
import { runRipgrep } from "../tools/run-ripgrep.ts";
import type { RipgrepMatch } from "../tools/types.ts";

// CallerResolver finds the CROSS-FILE call sites of a changed function so
// the caller-impact block can quantify "who breaks if this signature changes".
// The grep impl is best-effort: classification is regex-on-line (a separate
// graph-backed eval is what validates precision). It NEVER throws — a search
// failure degrades to `unavailable:true` so the caller emits no block rather
// than a wrong one.

/** A single call site, with `file` normalized to a cwd-relative path. */
export interface CallerRef {
  file: string;
  line: number;
}

export interface CallerSet {
  /** CROSS-FILE callers only — callsites in files NOT in `excludeFiles`. */
  callers: CallerRef[];
  /** Count of definition sites found for `name` (across ALL files). */
  defs: number;
  /** `defs > 1` — same name defined in multiple places. */
  ambiguous: boolean;
  /** Number of cross-file callers found (`== callers.length` pre any display cap). */
  callsiteCount: number;
  /** True only when the resolver could not run; grep sets false on success. */
  unavailable: boolean;
  /**
   * Graph-only — true when the index is older than the working tree.
   * Grep never sets it (stays undefined). When true, the block-assembler emits
   * file-level callers (no `:line`, which the stale index can't be trusted on)
   * plus a freshness stamp. Optional ⇒ grep behavior is byte-identical.
   */
  stale?: boolean;
}

export interface ResolveOpts {
  cwd: string;
  /** Diff's changed files (cwd-relative); their callsites are NOT cross-file. */
  excludeFiles: string[];
}

export interface CallerResolver {
  resolveCallers(name: string, opts: ResolveOpts): Promise<CallerSet>;
}

/** A single match line, the subset of `RipgrepMatch` the classifier needs. */
export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** Injectable search seam: given a call-form pattern + cwd, return raw matches. */
export type SearchFn = (args: {
  name: string;
  cwd: string;
}) => Promise<{ matches: SearchMatch[]; ok: boolean }>;

const UNAVAILABLE: CallerSet = {
  callers: [],
  defs: 0,
  ambiguous: false,
  callsiteCount: 0,
  unavailable: true,
};

/** Escape a symbol name for safe interpolation into a RegExp source. */
function escapeRe(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Default search: word-boundary call form `\bNAME\s*\(` over TS files via ripgrep. */
async function ripgrepSearch(args: {
  name: string;
  cwd: string;
}): Promise<{ matches: SearchMatch[]; ok: boolean }> {
  const pattern = `\\b${escapeRe(args.name)}\\s*\\(`;
  const result = await runRipgrep({
    cwd: args.cwd,
    patterns: [pattern],
    rgBin: getRgBin(),
  });
  if (result.status !== "ok") return { matches: [], ok: false };
  const matches: SearchMatch[] = result.parsed.map((m: RipgrepMatch) => ({
    file: m.file,
    line: m.line,
    text: m.text,
  }));
  return { matches, ok: true };
}

/**
 * Keep only TS-family files. `runRipgrep` doesn't pass `--type ts`, so a raw
 * search matches `.md` / `.json` / etc. — e.g. a function name quoted in a
 * journal or doc. A doc mention is NOT a caller; restrict to source extensions.
 */
const TS_FAMILY = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function isTsFamily(file: string): boolean {
  return TS_FAMILY.test(file);
}

/** Normalize a (possibly absolute) path to cwd-relative for stable comparison. */
function toRelative(file: string, cwd: string): string {
  // `relative` collapses an already-relative path against cwd too, but an
  // absolute input is the case rg produces (it echoes the abs `cwd` search arg).
  if (file.startsWith("/")) return relative(cwd, file);
  return file;
}

/** Is the matched `NAME(` a definition site? (best-effort, regex on the line) */
function isDefinition(text: string, name: string): boolean {
  const n = escapeRe(name);
  const patterns = [
    new RegExp(`function\\s+${n}\\b`),
    new RegExp(`(?:const|let|var)\\s+${n}\\s*=`),
    // method / function declaration with a body on the same line
    new RegExp(`\\b${n}\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`),
    // object / arrow property: `name: () =>` / `name = function`
    new RegExp(`\\b${n}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()`),
  ];
  return patterns.some((re) => re.test(text));
}

/** Is the matched `NAME(` comment/string noise we should skip? (best-effort) */
function isNoise(text: string, name: string): boolean {
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  )
    return true;
  // `NAME(` preceded by `//` anywhere on the line (inline trailing comment).
  const n = escapeRe(name);
  const callIdx = text.search(new RegExp(`\\b${n}\\s*\\(`));
  if (callIdx > 0) {
    const before = text.slice(0, callIdx);
    if (before.includes("//")) return true;
  }
  return false;
}

/**
 * Grep-backed resolver. The search function is injected (default = ripgrep) so
 * tests run deterministically without a real `rg` binary, and a fixture test can
 * pass the real one.
 */
export class GrepCallerResolver implements CallerResolver {
  private readonly search: SearchFn;

  constructor(search: SearchFn = ripgrepSearch) {
    this.search = search;
  }

  async resolveCallers(name: string, opts: ResolveOpts): Promise<CallerSet> {
    let result: { matches: SearchMatch[]; ok: boolean };
    try {
      result = await this.search({ name, cwd: opts.cwd });
    } catch {
      return { ...UNAVAILABLE };
    }
    if (!result.ok) return { ...UNAVAILABLE };

    const excluded = new Set(
      opts.excludeFiles.map((f) => toRelative(f, opts.cwd)),
    );

    // Track definition *files* (places), not raw def lines — TS overload
    // signatures put N def lines in ONE file and must not read as ambiguity.
    const defFiles = new Set<string>();
    const seen = new Set<string>();
    const callers: CallerRef[] = [];

    for (const m of result.matches) {
      const rel = toRelative(m.file, opts.cwd);
      if (!isTsFamily(rel)) continue; // doc/json mentions are not call sites
      if (isDefinition(m.text, name)) {
        defFiles.add(rel);
        continue;
      }
      if (isNoise(m.text, name)) continue;
      // call site
      if (excluded.has(rel)) continue;
      const key = `${rel}:${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callers.push({ file: rel, line: m.line });
    }

    return {
      callers,
      defs: defFiles.size,
      ambiguous: defFiles.size > 1,
      callsiteCount: callers.length,
      unavailable: false,
    };
  }
}
