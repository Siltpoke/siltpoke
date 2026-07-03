// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Filesystem browser primitives for the in-dashboard folder
 * picker. PRESENCE-ONLY: every check here reads directory entry *names* + types
 * (`readdirSync` / `Dirent`) — it NEVER opens file contents. The daemon route
 * is the secret-gated, allow-root-contained caller.
 */
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_EXT_TO_LANG } from "./walker";

/** Project-root marker filenames whose mere presence signals "codebase". */
const PROJECT_MARKERS = new Set<string>([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
]);

/** Hard cap on subdirectories returned in one listing (DoS guard). */
export const MAX_ENTRIES = 500;

function hasSourceExt(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  const ext = name.slice(i + 1).toLowerCase();
  return Object.hasOwn(SOURCE_EXT_TO_LANG, ext);
}

/**
 * Does `realDir` look like a code repository? Shallow + presence-only (reads
 * entry names + types, never opens a file; false on an unreadable dir).
 *
 * Two thresholds for two jobs:
 * - **broad** (default, the browse *badge*): a project marker OR ≥1 source file
 *   — "there's code here," a useful navigation hint.
 * - **markersOnly** (the Index *enable-gate*): a project marker only (`.git`,
 *   `package.json`, `tsconfig*.json`, `pyproject.toml`, …). A real project root
 *   nearly always has a marker; a folder with only a stray `db_schema.py` (e.g.
 *   `~/Downloads`) does not → it soft-blocks the gate (override still available).
 */
export function detectCodebase(realDir: string, opts: { markersOnly?: boolean } = {}): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(realDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const n = e.name;
    if (n === ".git") return true; // dir (normal) or file (worktree) — presence signals a repo
    if (PROJECT_MARKERS.has(n)) return true;
    if (n.startsWith("tsconfig") && n.endsWith(".json")) return true;
  }
  if (opts.markersOnly) return false;
  // broad badge only: a lone source file counts as "code here" but NOT as an
  // index-worthy project root (that's the markers-only gate above).
  return entries.some((e) => e.isFile() && hasSourceExt(e.name));
}

export interface FsEntry {
  name: string;
  /** Absolute path of the subdirectory. */
  path: string;
  /** Badge hint — does this subdir look like a codebase? */
  isCodebase: boolean;
}

export interface FsListing {
  entries: FsEntry[];
  /** Set when the dir had > MAX_ENTRIES subdirs: count omitted (FE shows "+N more"). */
  truncated?: number;
}

/**
 * Immediate subdirectories of `realDir` for the folder browser — sorted, with
 * dotdirs + `node_modules` hidden, capped at MAX_ENTRIES, each tagged
 * with a `detectCodebase` badge. Symlinked dirs are not listed (real dirs only;
 * the route realpath-validates on navigation anyway). Empty on an unreadable dir.
 */
export function listSubdirs(realDir: string): FsListing {
  let raw: Dirent[];
  try {
    raw = readdirSync(realDir, { withFileTypes: true });
  } catch {
    return { entries: [] };
  }
  const dirNames = raw
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  // Cap BEFORE the per-entry detectCodebase fan-out: each kept entry triggers
  // one synchronous readdirSync (in detectCodebase), so the MAX_ENTRIES cap is
  // also the bound on that fan-out — do not remove it thinking it's arbitrary.
  // Child paths are `join(realDir, name)` off the already-validated parent (the
  // route ran validateListDir on realDir), so they're contained by construction.
  const kept = dirNames.slice(0, MAX_ENTRIES);
  const entries: FsEntry[] = kept.map((name) => {
    const path = join(realDir, name);
    return { name, path, isCodebase: detectCodebase(path) };
  });
  const out: FsListing = { entries };
  if (dirNames.length > MAX_ENTRIES) out.truncated = dirNames.length - MAX_ENTRIES;
  return out;
}
