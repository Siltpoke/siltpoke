// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Index-time anchor discovery (alias-edge resolution, 2026-06-08).
 *
 * Produces the `AnchorMap` baked into `meta.json` so the consume-time resolver
 * can follow tier-4 imports (TS path-aliases + non-repo-root Python absolute
 * imports) while staying a pure function over the file index.
 *
 * Two discovery mechanisms, unified only at the produced `AnchorMap`:
 *   - TS:     read the project's OWN tsconfig/jsconfig `paths` + `baseUrl`
 *             (alias mappings are arbitrary → only the declared config knows them).
 *   - Python: structural import-anchored inference (the dotted path carries
 *             enough to reverse-infer the source root; config is often absent).
 *
 * Zero framework / dir / repo-name hardcoding (red line, grep-guarded). The
 * only inputs are config-schema keys, language package markers (`__init__.py`),
 * path structure, and the imports themselves.
 */
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { AnchorMap, RepoGraph, TsAliasRule } from "./types";

export interface PyImport {
  /** Repo-relative path of the importing `.py` file. */
  src: string;
  /** Absolute dotted import target, e.g. "a.b.c" (no leading dot). */
  target: string;
}

// ---------------------------------------------------------------------------
// Python source roots — structural, import-anchored.
// ---------------------------------------------------------------------------

/**
 * Discover Python source roots. A directory `D` is a source root iff,
 * for some absolute dotted import `a.b.c`:
 *   - a file `D/a/b/c.py` or `D/a/b/c/__init__.py` is in the index, AND
 *   - `D/a/__init__.py` is in the index (so `a` is a real package — blocks a
 *     coincidental suffix match), AND
 *   - the import resolves **uniquely** under `D` (exactly one candidate root).
 * The repo root ("") is never returned — tier-3 already anchors there.
 * Consults the indexed source set only (vendored copies are not indexed).
 */
/**
 * Candidate source roots under which `imp` resolves: prefix dirs `D` where a
 * file `D/<rel>.py` | `D/<rel>/__init__.py` is indexed AND `D/<first>/__init__.py`
 * is indexed (real package). Segment-boundary guarded so tail "pkg/m.py" cannot
 * match file "xpkg/m.py".
 */
function candidateRoots(
  imp: PyImport,
  filePaths: string[],
  index: Set<string>,
): Set<string> {
  const rel = imp.target.replace(/\./g, "/");
  const first = imp.target.slice(0, imp.target.indexOf("."));
  const tails = [`${rel}.py`, `${rel}/__init__.py`];
  const roots = new Set<string>();
  for (const f of filePaths) {
    for (const tail of tails) {
      if (!f.endsWith(tail)) continue;
      const d = f.slice(0, f.length - tail.length);
      if (d !== "" && !d.endsWith("/")) continue; // boundary
      if (index.has(`${d}${first}/__init__.py`)) roots.add(d); // package validity
    }
  }
  return roots;
}

export function discoverPythonRoots(
  filePaths: string[],
  pyImports: PyImport[],
): string[] {
  const index = new Set(filePaths);
  const confirmed = new Set<string>();
  for (const imp of pyImports) {
    if (imp.target.startsWith(".") || !imp.target.includes(".")) continue;
    const roots = candidateRoots(imp, filePaths, index);
    const [only] = [...roots];
    if (roots.size === 1 && only !== undefined) confirmed.add(only); // unique → confirm
  }
  confirmed.delete(""); // repo root is tier-3, not a baked extra root
  return [...confirmed].sort();
}

// ---------------------------------------------------------------------------
// TS path-alias rules — read the project's own tsconfig/jsconfig.
// ---------------------------------------------------------------------------

export interface TsConfigShape {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

/** Strip a trailing `*` (or `/​*`) wildcard marker from an alias key / target. */
function stripStar(s: string): string {
  return s.endsWith("*") ? s.slice(0, -1) : s;
}

/** Resolve a `paths` target value against (scopeDir + baseUrl); trailing slash. */
function joinScoped(scopeDir: string, baseUrl: string, target: string): string {
  let out = posix.normalize(`${scopeDir}${baseUrl}/${stripStar(target)}`);
  if (out.startsWith("./")) out = out.slice(2);
  if (out === "." || out === "") return scopeDir || "";
  if (!out.endsWith("/")) out += "/";
  return out;
}

/**
 * Build alias rules from ONE parsed config located at `scopeDir` (repo-relative,
 * trailing slash; "" = repo root). Reads only the TS config schema keys
 * (`baseUrl`, `paths`) — never an alias literal or framework name.
 */
export function tsAliasRulesFromConfig(
  scopeDir: string,
  cfg: TsConfigShape,
): TsAliasRule[] {
  const co = cfg.compilerOptions ?? {};
  const baseUrl = co.baseUrl ?? ".";
  const paths = co.paths;

  if (!paths || Object.keys(paths).length === 0) {
    // baseUrl-only: bare imports anchor off baseUrl. No baseUrl → nothing.
    if (co.baseUrl === undefined) return [];
    return [{ scopeDir, prefix: "", targets: [joinScoped(scopeDir, baseUrl, ".")] }];
  }

  const rules: TsAliasRule[] = [];
  for (const [key, targets] of Object.entries(paths)) {
    rules.push({
      scopeDir,
      prefix: stripStar(key),
      targets: targets.map((t) => joinScoped(scopeDir, baseUrl, t)),
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Index-time orchestrator (the only disk-reading entry point).
// ---------------------------------------------------------------------------

/** Tolerantly parse a tsconfig/jsconfig (JSONC: // + /* *​/ comments, trailing
 *  commas). Returns null on irrecoverable parse failure. */
function parseJsonc(text: string): TsConfigShape | null {
  for (const candidate of [text, stripJsonc(text)]) {
    try {
      return JSON.parse(candidate) as TsConfigShape;
    } catch {
      // try the stripped form next
    }
  }
  return null;
}

function stripJsonc(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:"])\/\/[^\n]*/g, "$1") // line comments (skip "://" + in-string-ish)
    .replace(/,(\s*[}\]])/g, "$1"); // trailing commas
}

// Mirror the walker's ignore set: indexed files never come from these dirs, so
// a config inside one governs no indexed file and would only add noise.
const CONFIG_SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "dist",
  "build",
  ".git",
  "tests",
  "docs",
]);

/**
 * Repo-relative tsconfig/jsconfig paths found ON DISK under `repoRoot`. These
 * are NOT source files, so the indexer never adds them as graph nodes — they
 * must be globbed from disk (the index-time disk access this track is allowed).
 * Vendored config copies (node_modules, .venv) are skipped.
 */
function configFilesOnDisk(repoRoot: string): string[] {
  const out: string[] = [];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const glob = new Bun.Glob(`**/${name}`);
    for (const rel of glob.scanSync({ cwd: repoRoot, onlyFiles: true })) {
      if (rel.split("/").some((seg) => CONFIG_SKIP_DIRS.has(seg))) continue;
      out.push(rel);
    }
  }
  return out;
}

/** Extract (src, dotted-target) absolute Python imports from the graph's raw edges. */
function pythonImports(graph: RepoGraph): PyImport[] {
  const out: PyImport[] = [];
  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const m = /^file:([^:]+):$/.exec(e.source);
    const src = m?.[1];
    if (src === undefined || !src.endsWith(".py")) continue;
    if (e.target.startsWith(".") || !e.target.includes(".")) continue; // relative / bare
    out.push({ src, target: e.target });
  }
  return out;
}

/**
 * Index-time anchor discovery. `repoRoot` is the on-disk project root (the only
 * disk access in this track). TS aliases come from the project's own configs;
 * Python roots are inferred structurally from the graph's imports.
 */
export function discoverAnchorMap(repoRoot: string, graph: RepoGraph): AnchorMap {
  const filePaths = graph.nodes
    .filter((n) => n.type === "file")
    .map((n) => n.path);

  const tsAliases: TsAliasRule[] = [];
  for (const cfgRel of configFilesOnDisk(repoRoot)) {
    const abs = `${repoRoot}/${cfgRel}`;
    if (!existsSync(abs)) continue;
    const parsed = parseJsonc(readFileSync(abs, "utf8"));
    if (!parsed) continue;
    const slash = cfgRel.lastIndexOf("/");
    const scopeDir = slash >= 0 ? cfgRel.slice(0, slash + 1) : "";
    tsAliases.push(...tsAliasRulesFromConfig(scopeDir, parsed));
  }

  const pythonRoots = discoverPythonRoots(filePaths, pythonImports(graph));
  return { tsAliases, pythonRoots };
}
