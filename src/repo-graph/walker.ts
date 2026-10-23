// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Walk a project directory yielding source files.
 *
 * Skips:
 *  - Hardcoded directories (`node_modules`, `dist`, `.git`, etc.)
 *  - Files over 1MB
 *  - Files without one of the supported source extensions (ts/tsx/js/jsx/py)
 *
 * Returns a lazy async generator so the builder can stream-process big
 * repos without loading the full file list into memory upfront.
 */
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SupportedLang } from "../critic/rubric/tier2/ast-loader";

export const SOURCE_EXT_TO_LANG: Record<string, SupportedLang> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "py",
};

/** Directories we never descend into. Mirrors siltpoke's existing .gitignore + lint:files ignores. */
const SKIP_DIRS = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  ".siltpoke",
  ".playwright-tmp",
  "playwright-report",
  "test-results",
  "local_cache",
  ".claude",
  ".cache",
  ".turbo",
  ".vercel",
  "coverage",
  // docs hold design mockups (e.g. path-highlight/app.js) and public
  // holds built client bundles (public/static/index.js). Both are non-source
  // JS that pollute the code graph: minified/common names (set/has/track)
  // collide and wreck call-edge name resolution + coverage. tests/ is the same
  // class — helper names (add/seed/fn) collide and derail trace spines into
  // test files. Exclude all three from the code-structure graph.
  "docs",
  "public",
  "tests",
]);

/**
 * Skipped for the CODE graph but still listed as other files: their source
 * would derail call resolution (see SKIP_DIRS), but a reader of Code Map
 * still wants to see that `docs/` and `tests/` exist. `public` stays fully
 * skipped — it holds built bundles, not anything a person wrote.
 */
const OTHERS_ONLY_DIRS = new Set<string>(["docs", "tests"]);

/** Max other (non-code) file paths listed in one walk. Only paths are kept —
 * no stat, no read — so this bounds payload size, not work. */
export const MAX_OTHER_FILES = 5_000;

/** Files we never index (generated, hidden config, secrets). */
const SKIP_FILES = new Set<string>([
  ".DS_Store",
]);

/** Max single-file size we'll attempt to parse. */
export const MAX_FILE_BYTES = 1_000_000;

/**
 * Max indexable source files in one walk. The walk is unbounded by default,
 * so a pathological tree (millions of files) is a real resource-exhaustion
 * vector once the indexer is reachable from a daemon endpoint.
 * Cap it; the cap is configurable per-call for testing.
 */
export const MAX_FILES = 25_000;

export interface WalkedFile {
  /** Absolute path on disk. */
  absPath: string;
  /** Project-root-relative path with forward slashes. */
  relPath: string;
  /** Extension without leading dot, lowercase. */
  ext: string;
  /** tree-sitter grammar key. */
  lang: SupportedLang;
  /** File size in bytes (caller may still bail on > MAX_FILE_BYTES). */
  size: number;
}

export interface WalkSkip {
  reason: "too_large" | "not_a_source_file" | "file_cap";
  relPath: string;
  size?: number;
}

export interface WalkResult {
  files: WalkedFile[];
  skipped: WalkSkip[];
  /** Files that are not in the code graph but exist in the project — non-code
   * files, oversized code files, and everything under OTHERS_ONLY_DIRS.
   * Code Map draws them as plain files; nothing parses them. */
  others: string[];
  /** True when `others` stopped at the cap. */
  othersTruncated: boolean;
}

function toRelPath(absPath: string, projectRoot: string): string {
  return relative(projectRoot, absPath).split(sep).join("/");
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/**
 * Walk a project directory, returning indexable files + skip reasons.
 * This is eager (returns the full list) because the index builds in one
 * shot. If repos grow large enough to warrant streaming, swap to an
 * async generator later (interface stays compatible).
 */
export async function walkProject(
  projectRoot: string,
  opts: {
    maxFiles?: number;
    maxOthers?: number;
    /** false: skip the other-file listing (and the docs/ tests/ walk) — for
     * callers that only need the code files, like the staleness check. */
    listOthers?: boolean;
    /** Applied BEFORE the cap, so rejected files (gitignored) never take a slot. */
    keepOther?: (relPath: string) => boolean;
  } = {},
): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const maxOthers = opts.maxOthers ?? MAX_OTHER_FILES;
  const listOthers = opts.listOthers ?? true;
  const keepOther = opts.keepOther;
  const files: WalkedFile[] = [];
  const skipped: WalkSkip[] = [];
  const others: string[] = [];
  let othersTruncated = false;
  let capped = false;

  const addOther = (relPath: string): void => {
    if (!listOthers || (keepOther && !keepOther(relPath))) return;
    if (others.length < maxOthers) others.push(relPath);
    else othersTruncated = true;
  };

  /** `othersOnly`: inside an OTHERS_ONLY_DIRS subtree — list every file, index none. */
  async function recurse(dir: string, othersOnly: boolean): Promise<void> {
    if (capped) return; // hit the file cap — unwind without descending further
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied / not a directory — skip silently
    }
    for (const entry of entries) {
      if (capped) return;
      const name = entry.name;
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        if (name.startsWith(".")) continue;
        if (OTHERS_ONLY_DIRS.has(name)) {
          if (listOthers) await recurse(abs, true);
          continue;
        }
        if (SKIP_DIRS.has(name)) continue;
        await recurse(abs, othersOnly);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(name)) continue;

      const ext = extOf(name);
      const lang = SOURCE_EXT_TO_LANG[ext];
      const relPath = toRelPath(abs, projectRoot);

      if (othersOnly) {
        addOther(relPath);
        continue;
      }
      if (!lang) {
        skipped.push({ reason: "not_a_source_file", relPath });
        addOther(relPath);
        continue;
      }

      let size = 0;
      try {
        const s = await stat(abs);
        size = s.size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        skipped.push({ reason: "too_large", relPath, size });
        addOther(relPath); // not parsed, but it exists — draw it as a plain file
        continue;
      }

      if (files.length >= maxFiles) {
        // Stop adding past the cap; record one marker + abort the whole walk.
        skipped.push({ reason: "file_cap", relPath });
        capped = true;
        return;
      }
      files.push({ absPath: abs, relPath, ext, lang, size });
    }
  }

  await recurse(projectRoot, false);
  return { files, skipped, others, othersTruncated };
}
