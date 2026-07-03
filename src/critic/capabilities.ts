// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { spawnWithTimeout } from "./spawn";

export type ProjectCapabilities = {
  cwd: string;
  hasGit: boolean;
  hasTsc: boolean;
  hasEslint: boolean;
  hasRipgrep: boolean;
  tsconfigPaths: string[]; // sorted by depth (root first); used for nearest-ancestor lookup
  eslintConfigPaths: string[];
  detectedAt: number; // ms epoch
  configMtimes: Record<string, number>; // for invalidation; key = absolute path, value = mtime ms
};

// ---------------------------------------------------------------------------
// Spawn probe helpers
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Spawn a command with an array of args and return whether it exits 0.
 * Never throws; returns false on ENOENT/timeout/non-zero.
 * Args are pinned — never include user-controlled data.
 */
async function probeBinaryRaw(argv: string[], cwd: string): Promise<boolean> {
  const result = await spawnWithTimeout({ argv, cwd, timeoutMs: PROBE_TIMEOUT_MS });
  return !result.timedOut && result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// File globbing helpers (recursive, max depth 4, skip excluded dirs)
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build"]);

/**
 * Recursively collect files matching `predicate` under `dir`, up to `maxDepth`.
 * Excludes directories in EXCLUDED_DIRS.
 */
async function collectFiles(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth: number,
  currentDepth = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];

  const results: string[] = [];
  let entries: { name: string; isDirectory: () => boolean }[];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        const sub = await collectFiles(fullPath, predicate, maxDepth, currentDepth + 1);
        results.push(...sub);
      }
    } else {
      if (predicate(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function isTsconfigFile(name: string): boolean {
  return /^tsconfig.*\.json$/.test(name);
}

const ESLINT_CONFIG_PATTERN =
  /^\.eslintrc(\.(json|ya?ml|js|cjs|mjs))?$|^eslint\.config\.(js|mjs|cjs|ts)$/;

function isEslintConfigFile(name: string): boolean {
  return ESLINT_CONFIG_PATTERN.test(name);
}

/**
 * Sort an array of paths by depth (fewest path segments first = root-first),
 * then alphabetically within the same depth level.
 */
function sortByDepthThenAlpha(paths: string[], cwd: string): string[] {
  return [...paths].sort((a, b) => {
    const depthA = relative(cwd, dirname(a)).split("/").filter(Boolean).length;
    const depthB = relative(cwd, dirname(b)).split("/").filter(Boolean).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// Set equality helper
// ---------------------------------------------------------------------------

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

// ---------------------------------------------------------------------------
// mtime helpers
// ---------------------------------------------------------------------------

async function getMtime(filePath: string): Promise<number | null> {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

async function buildConfigMtimes(
  paths: string[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    paths.map(async (p) => {
      const mtime = await getMtime(p);
      return mtime !== null ? ([p, mtime] as const) : null;
    }),
  );
  return Object.fromEntries(entries.filter((e): e is [string, number] => e !== null));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getProjectCapabilities(cwd: string): Promise<ProjectCapabilities> {
  const absDir = resolve(cwd);

  // 1. Git detection — presence of .git/ directly under cwd (no upward walk)
  const hasGit = existsSync(join(absDir, ".git"));

  // 2. Binary probes (parallel)
  // Args are pinned — never interpolate cwd or user data into argv.
  const [hasTsc, hasEslint, hasRipgrep] = await Promise.all([
    probeBinaryRaw(["bunx", "tsc", "--version"], absDir),
    probeBinaryRaw(["bunx", "eslint", "--version"], absDir),
    probeBinaryRaw(["rg", "--version"], absDir),
  ]);

  // 3. Config file discovery (parallel, max depth 4 from cwd)
  const [tsconfigPaths, eslintConfigPaths] = await Promise.all([
    collectFiles(absDir, isTsconfigFile, 4),
    collectFiles(absDir, isEslintConfigFile, 4),
  ]);

  const sortedTsconfigs = sortByDepthThenAlpha(tsconfigPaths, absDir);
  const sortedEslintConfigs = sortByDepthThenAlpha(eslintConfigPaths, absDir);

  // 4. configMtimes: all config paths + .git/HEAD if hasGit
  const mtimePaths = [...sortedTsconfigs, ...sortedEslintConfigs];
  if (hasGit) {
    mtimePaths.push(join(absDir, ".git", "HEAD"));
  }
  const configMtimes = await buildConfigMtimes(mtimePaths);

  return {
    cwd: absDir,
    hasGit,
    hasTsc,
    hasEslint,
    hasRipgrep,
    tsconfigPaths: sortedTsconfigs,
    eslintConfigPaths: sortedEslintConfigs,
    detectedAt: Date.now(),
    configMtimes,
  };
}

export async function invalidateCapabilitiesIfStale(
  caps: ProjectCapabilities,
): Promise<boolean> {
  const absDir = resolve(caps.cwd);

  // Re-stat every key in configMtimes in parallel; return true if any mtime changed or file disappeared
  const entries = Object.entries(caps.configMtimes);
  const currentMtimes = await Promise.all(entries.map(([filePath]) => getMtime(filePath)));
  for (let i = 0; i < entries.length; i++) {
    const [_filePath, recordedMtime] = entries[i]!;
    const currentMtime = currentMtimes[i];
    if (currentMtime === null) {
      // File disappeared
      return true;
    }
    if (currentMtime !== recordedMtime) {
      // mtime changed
      return true;
    }
  }

  // Check if new config files have appeared or been removed since detection (set comparison catches net-neutral swaps)
  const [currentTsconfigsArr, currentEslintConfigsArr] = await Promise.all([
    collectFiles(absDir, isTsconfigFile, 4),
    collectFiles(absDir, isEslintConfigFile, 4),
  ]);

  const currentTsconfigs = new Set(currentTsconfigsArr);
  const cachedTsconfigs = new Set(caps.tsconfigPaths);
  if (!setsEqual(currentTsconfigs, cachedTsconfigs)) return true;

  const currentEslintConfigs = new Set(currentEslintConfigsArr);
  const cachedEslintConfigs = new Set(caps.eslintConfigPaths);
  if (!setsEqual(currentEslintConfigs, cachedEslintConfigs)) return true;

  return false;
}

export function findNearestTsconfig(
  changedFile: string,
  caps: ProjectCapabilities,
): string | null {
  const absFile = resolve(caps.cwd, changedFile);

  let bestMatch: string | null = null;
  let bestDepth = -1;

  for (const tsconfigPath of caps.tsconfigPaths) {
    const tsconfigDir = dirname(tsconfigPath);
    // Check if tsconfigDir is an ancestor of absFile
    const rel = relative(tsconfigDir, absFile);
    // If rel starts with "..", the file is not under this dir
    if (rel.startsWith("..")) continue;

    // Depth = number of segments in the directory path (deeper = better match)
    const depth = tsconfigDir.split("/").filter(Boolean).length;
    if (depth > bestDepth) {
      bestDepth = depth;
      bestMatch = tsconfigPath;
    }
  }

  return bestMatch;
}
