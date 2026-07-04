// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Generic, consume-time import resolution.
 *
 * The extractor stores import edges with RAW target strings (`"../foo"`,
 * `"agent.nodes"`, `"react"`) and never resolves them — that keeps each edge
 * stable across incremental rebuilds (resolution is a GLOBAL fact, not a per-file
 * one). This module is the consume-time resolver the aggregator calls to turn a
 * raw target into a concrete repo-relative file path, matched against the live
 * file index. It changes no on-disk schema (no new persisted edge type).
 *
 * Generic rules only — NO framework hardcoding. Language is
 * inferred from the importing file's extension:
 *   - relative      (TS `./`/`../`, Python leading-dot, N dots = N−1 parent levels)
 *   - ext / index   (`.ts/.tsx/.js/.jsx/.mjs/.cjs/.py`, then `index.*`, `__init__.py`)
 *   - Python dotted (`a.b.c` → `a/b/c.py` | `a/b/c/__init__.py`, repo-root-anchored)
 *   - bare specifier (`react`, `os`, `@pkg`) → null (external, never an internal edge)
 *
 * tsconfig `paths`/baseUrl aliases (tier 4) are deliberately deferred.
 * Next.js app-router conventions are out (routing-by-convention, not imports).
 */
import { posix } from "node:path";
import type { AnchorMap, RepoGraph } from "./types";

const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TS_INDEX = TS_EXTS.map((e) => `index${e}`);
const PY_EXTS = [".py"];
const PY_PKG = ["__init__.py"];

/** Repo-relative file paths present in the graph — the resolution target set. */
export function buildFileIndex(graph: RepoGraph): Set<string> {
  const idx = new Set<string>();
  for (const n of graph.nodes) if (n.type === "file") idx.add(n.path);
  return idx;
}

function isPython(sourceFilePath: string): boolean {
  return sourceFilePath.endsWith(".py");
}

/** Try a base path against ext + index/package candidates. Handles the NodeNext/
 * ESM convention where a TS file imports `'./x.js'` to mean `./x.ts` — a generic
 * module-resolution rule (not framework-specific): a trailing JS/TS-family
 * extension is also tried with the extension stripped, so the source exts apply.
 * An empty base (a bare current-package import) resolves to its package file. */
function guess(base: string, exts: string[], pkgFiles: string[], idx: Set<string>): string | null {
  const stems = [base];
  const ext = /\.(js|jsx|mjs|cjs|ts|tsx)$/.exec(base);
  if (ext) stems.push(base.slice(0, -ext[0].length)); // 'x.js' → also try 'x' + source exts
  for (const stem of stems) {
    let clean = posix.normalize(stem);
    if (clean === ".") clean = ""; // current package root → resolves to its package file
    if (clean) {
      if (idx.has(clean)) return clean; // already a full path with a real extension
      for (const e of exts) if (idx.has(clean + e)) return clean + e;
    }
    for (const pkg of pkgFiles) {
      const cand = clean ? posix.join(clean, pkg) : pkg;
      if (idx.has(cand)) return cand;
    }
  }
  return null;
}

/**
 * Resolve a raw import target to a concrete repo-relative file path in `idx`,
 * or null for an external / unresolvable / bare specifier.
 *
 * `anchorMap` (optional) enables tier-4 resolution (TS path-aliases + Python
 * source roots, discovered at index time). Without it, behavior is byte-
 * identical to tier-1–3 — a stale pre-anchor index resolves exactly as before.
 */
export function resolveImportTarget(
  sourceFilePath: string,
  rawTarget: string,
  idx: Set<string>,
  anchorMap?: AnchorMap,
): string | null {
  const tier123 = resolveTier123(sourceFilePath, rawTarget, idx);
  if (tier123) return tier123;
  if (!anchorMap) return null;
  return resolveTier4(sourceFilePath, rawTarget, idx, anchorMap);
}

/** Tiers 1–3: relative + ext/index + Python-dotted (repo-root anchored). */
function resolveTier123(
  sourceFilePath: string,
  rawTarget: string,
  idx: Set<string>,
): string | null {
  if (!rawTarget) return null;
  const py = isPython(sourceFilePath);
  const exts = py ? PY_EXTS : TS_EXTS;
  const indexish = py ? PY_PKG : TS_INDEX;
  const sourceDir = posix.dirname(sourceFilePath);

  // TS relative: ./x or ../x
  if (!py && (rawTarget.startsWith("./") || rawTarget.startsWith("../"))) {
    return guess(posix.join(sourceDir, rawTarget), exts, indexish, idx);
  }

  // Python relative: leading dots. 1 dot = current package, N dots = up N−1.
  if (py && rawTarget.startsWith(".")) {
    const dots = rawTarget.length - rawTarget.replace(/^\.+/, "").length;
    const rest = rawTarget.slice(dots).replace(/\./g, "/"); // remaining dotted path
    let dir = sourceDir;
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir); // up N−1 levels
    return guess(rest ? posix.join(dir, rest) : dir, exts, indexish, idx);
  }

  // Python absolute dotted: a.b.c → a/b/c (repo-root anchored).
  if (py && rawTarget.includes(".")) {
    const base = rawTarget.replace(/\./g, "/");
    const hit = guess(base, exts, indexish, idx);
    if (hit) return hit;
    // Fallback: `from a.b import c` stored as "a.b.c" where c is a symbol in b —
    // drop the last segment and retry as a module.
    const parent = base.slice(0, base.lastIndexOf("/"));
    return parent ? guess(parent, exts, indexish, idx) : null;
  }

  // Bare specifier (npm pkg / node: builtin / single-token Python stdlib) → external.
  return null;
}

/**
 * Tier-4: resolve via discovered anchors. Unique-or-null — a resolved
 * edge must land on exactly one real file, else null (precision over recall).
 */
function resolveTier4(
  sourceFilePath: string,
  rawTarget: string,
  idx: Set<string>,
  anchorMap: AnchorMap,
): string | null {
  if (isPython(sourceFilePath)) {
    return resolvePythonRoots(rawTarget, idx, anchorMap.pythonRoots);
  }
  if (rawTarget.startsWith("./") || rawTarget.startsWith("../")) return null;
  return resolveTsAlias(sourceFilePath, rawTarget, idx, anchorMap.tsAliases);
}

/** Python absolute dotted import against each source root; unique-or-null. */
function resolvePythonRoots(
  rawTarget: string,
  idx: Set<string>,
  roots: string[],
): string | null {
  if (rawTarget.startsWith(".") || !rawTarget.includes(".")) return null;
  const rel = rawTarget.replace(/\./g, "/");
  const hits = new Set<string>();
  for (const root of roots) {
    const r = guess(`${root}${rel}`, PY_EXTS, PY_PKG, idx);
    if (r) hits.add(r);
  }
  const [only] = [...hits];
  return hits.size === 1 && only !== undefined ? only : null;
}

/**
 * TS path-alias resolution. Within the source file's NEAREST enclosing config
 * (longest scopeDir), try matching prefix rules MOST-SPECIFIC first. The first
 * rule that yields any file decides: exactly one → resolve; multiple distinct
 * (multi-target) → null (ambiguous). A rule that yields nothing falls through
 * to the next, shorter prefix (TS "first matching pattern with an existing file").
 */
/** Files an alias rule's targets resolve `rest` to (distinct set). */
function aliasRuleHits(
  rule: AnchorMap["tsAliases"][number],
  rawTarget: string,
  idx: Set<string>,
): Set<string> {
  const rest = rule.prefix ? rawTarget.slice(rule.prefix.length) : rawTarget;
  const hits = new Set<string>();
  for (const t of rule.targets) {
    const r = guess(`${t}${rest}`, TS_EXTS, TS_INDEX, idx);
    if (r) hits.add(r);
  }
  return hits;
}

/**
 * Rules of the source file's NEAREST enclosing config (longest scopeDir) whose
 * prefix matches `rawTarget`, sorted most-specific prefix first.
 */
function matchingAliasRules(
  sourceFilePath: string,
  rawTarget: string,
  aliases: AnchorMap["tsAliases"],
): AnchorMap["tsAliases"] {
  const scoped = aliases
    .filter((a) => sourceFilePath.startsWith(a.scopeDir))
    .sort((x, y) => y.scopeDir.length - x.scopeDir.length);
  const topScope = scoped[0]?.scopeDir;
  if (topScope === undefined) return [];
  return scoped
    .filter((a) => a.scopeDir === topScope)
    .filter((a) => a.prefix === "" || rawTarget.startsWith(a.prefix))
    .sort((x, y) => y.prefix.length - x.prefix.length);
}

function resolveTsAlias(
  sourceFilePath: string,
  rawTarget: string,
  idx: Set<string>,
  aliases: AnchorMap["tsAliases"],
): string | null {
  for (const rule of matchingAliasRules(sourceFilePath, rawTarget, aliases)) {
    const hits = aliasRuleHits(rule, rawTarget, idx);
    if (hits.size === 0) continue; // fall through to the next, shorter prefix
    const [only] = [...hits];
    return hits.size === 1 && only !== undefined ? only : null; // unique-or-null
  }
  return null;
}
