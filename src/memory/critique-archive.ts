// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Walk `<base>/critiques/archive/<date>/*.md` and parse each critique file,
 * reusing a file's parse while the file is unchanged.
 *
 * WHY A CACHE. Every Memory page load walked the whole archive: in siltpoke
 * 7,767 files / 143 MB, read one at a time, to keep 81 entries — measured
 * 0.45 s warm and 1.2–4.9 s cold, nearly all of the page's server time. A file
 * is re-read only when its (mtime, size) changed since the last walk. Checking
 * that for every file costs 30–110 ms on the same archive.
 *
 * WHY PER FILE AND NOT PER DAY DIRECTORY. A directory's mtime moves when a file
 * is added or removed, not when one is rewritten in place — and
 * `setStatus` (src/state/critique-status.ts) rewrites archived critiques in
 * place. Today that only touches the `status:` line, which the parse ignores,
 * but a per-directory key would make that a silent contract.
 *
 * WHY BOUNDED READS. On a cache miss a day's files are read in parallel, and
 * the bound caps how many file bodies are in memory at once. It is NOT what
 * keeps the open-file limit away: measured under `ulimit -n 128`, an unbounded
 * read of 600 files still returned 600/600 — Bun queues the reads itself.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

type CritiqueEntry = { ts: Date; body: string };
type RawCritiqueEntry = { id: string; ts: Date; body: string };

/** Files read from disk at once on a cache miss. */
const READ_CONCURRENCY = 32;

type CachedFile = { mtimeMs: number; size: number; entry: CritiqueEntry | null };

/**
 * archive root → (file path → parse). Each walk rebuilds the inner map from the
 * files it saw, so a deleted file drops out and the cache never outgrows the
 * archive. Measured on siltpoke's 7,767 files: about 8 MB retained.
 * Cached entries (and their `ts` Date) are shared by every caller — read-only.
 */
const archiveCache = new Map<string, Map<string, CachedFile>>();

function parseCritiqueFile(content: string): CritiqueEntry | null {
  // Frontmatter: ---\nkey: value\n---
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;
  const frontmatterStr = frontmatterMatch[1] ?? "";

  const tsMatch = frontmatterStr.match(/^timestamp:\s*(.+)$/m);
  if (!tsMatch) return null;
  const ts = new Date(tsMatch[1]?.trim());
  if (Number.isNaN(ts.getTime())) return null;

  // Extract critique_for_claude body between the fence markers after the heading
  const bodyMatch = content.match(
    /## Critique \(for Claude[^\n]*\)\n\n(`{3,})\n([\s\S]*?)\n\1/,
  );
  if (!bodyMatch) return null;
  const body = bodyMatch[2]?.trim() ?? "";
  if (!body) return null;

  return { ts, body };
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Parse one file, or reuse the previous parse when (mtime, size) match.
 * Returns undefined for a file that could not be stat'ed or read (skipped, and
 * not cached, so the next walk tries again).
 */
async function readCached(
  path: string,
  previous: Map<string, CachedFile> | undefined,
): Promise<CachedFile | undefined> {
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = await stat(path));
  } catch {
    return undefined;
  }
  const hit = previous?.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  try {
    const content = await readFile(path, "utf8");
    return { mtimeMs, size, entry: parseCritiqueFile(content) };
  } catch {
    return undefined;
  }
}

/**
 * Walk `base/critiques/archive/<date>/*.md`, parse each critique file,
 * and collect entries passing `predicate` — the shared file-walking core for
 * loadRecentCritiques / loadAllCritiqueEntries /
 * loadAllCritiqueEntriesUnfiltered, which differ only in which entries pass
 * (time-gate + rubric-noise filter, rubric-noise filter only, or no filter)
 * and how the result is shaped. Returns entries newest-first (by ts, desc);
 * unreadable files/dirs are skipped, a missing/unreadable archive → [].
 */
export async function walkCritiqueArchive(
  base: string,
  predicate: (entry: CritiqueEntry) => boolean,
): Promise<RawCritiqueEntry[]> {
  const archiveRoot = join(base, "critiques", "archive");
  if (!existsSync(archiveRoot)) return [];

  const previous = archiveCache.get(archiveRoot);
  const seen = new Map<string, CachedFile>();
  const entries: RawCritiqueEntry[] = [];

  try {
    const dateDirs = await readdir(archiveRoot);
    for (const dateDir of dateDirs) {
      const dayPath = join(archiveRoot, dateDir);
      let files: string[];
      try {
        files = await readdir(dayPath);
      } catch {
        continue;
      }
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      // Indexed by position so entries keep readdir order (reads finish in any
      // order; the final sort is stable, so ties would otherwise reshuffle).
      const day: Array<CachedFile | undefined> = new Array(mdFiles.length);
      await forEachLimited(
        mdFiles.map((file, i) => ({ file, i })),
        READ_CONCURRENCY,
        async ({ file, i }) => {
          day[i] = await readCached(join(dayPath, file), previous);
        },
      );
      mdFiles.forEach((file, i) => {
        const cached = day[i];
        if (!cached) return;
        seen.set(join(dayPath, file), cached);
        const entry = cached.entry;
        if (entry && predicate(entry)) {
          // strip ".md" extension to get the id
          entries.push({ id: file.slice(0, -3), ts: entry.ts, body: entry.body });
        }
      });
    }
  } catch {
    return [];
  }

  archiveCache.set(archiveRoot, seen);
  entries.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  return entries;
}
