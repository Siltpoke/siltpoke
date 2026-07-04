// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * writeCriticSnapshot — persists the raw git-diff content from a critic
 * fire to disk so the /critic page can render "the code siltpoke was
 * looking at" alongside each comment/critique.
 *
 * Storage: ~/.siltpoke/critic-snapshots/<unix_ms>-<sessionShort>.diff
 * Retention: caller-supplied cap (default 200 most-recent files).
 *
 * Fail-soft: errors are swallowed (logged to stderr) so a snapshot write
 * failure NEVER blocks a critic fire.
 */
import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const SNAPSHOT_DIR_NAME = "critic-snapshots";
const DEFAULT_RETENTION = 200;
/**
 * Cap snapshot size on disk — clip oversized raw diffs to keep dir manageable.
 * Raised from 64KB to 512KB (2026-05-20): 64KB truncated mid-file on real diffs
 * with 15+ changed files; downstream parser then only saw the surviving complete
 * `diff --git` blocks (often 4-5 files), causing the dashboard to show "5 files"
 * for what Haiku summary correctly reported as 15. 512KB comfortably holds large
 * multi-file refactors without hitting the cap in practice; on the rare overflow
 * we now truncate at the LAST complete `diff --git` boundary so the parser still
 * sees clean file blocks rather than a half-parsed one.
 */
const MAX_BYTES = 512 * 1024;

/**
 * Truncate a unified diff to ≤max bytes, aligned at the last complete
 * `diff --git a/... b/...` boundary so parsers see whole file blocks.
 * Falls back to byte slice if no boundary found within budget.
 */
function truncateAtFileBoundary(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  const window = diff.slice(0, maxBytes);
  const lastBoundary = window.lastIndexOf("\ndiff --git ");
  if (lastBoundary > 0) {
    return `${window.slice(0, lastBoundary)}\n--- truncated: ${diff.length - lastBoundary} more bytes across additional files ---\n`;
  }
  return `${window}\n--- truncated ---\n`;
}

export interface SnapshotResult {
  /** Filename without dir prefix, e.g. "1779218068733-cb2f6607.diff". */
  id: string;
  /** Absolute path on disk. */
  path: string;
}

/**
 * Write a critic snapshot file. Returns the snapshot id (basename) on
 * success, undefined on failure. Caller embeds id in brain-calls.jsonl
 * so the reader can resolve back to disk.
 */
export async function writeCriticSnapshot(
  homeBase: string,
  sessionId: string,
  content: string,
  now: Date = new Date(),
  retention: number = DEFAULT_RETENTION,
): Promise<SnapshotResult | undefined> {
  if (!content || content.trim().length === 0) return undefined;

  const dir = join(homeBase, SNAPSHOT_DIR_NAME);
  const sessionShort = sessionId.slice(0, 8);
  const id = `${now.getTime()}-${sessionShort}.diff`;
  const path = join(dir, id);

  try {
    await mkdir(dir, { recursive: true });
    const body = truncateAtFileBoundary(content, MAX_BYTES);
    await writeFile(path, body, "utf8");

    // Best-effort retention sweep — delete oldest files past cap.
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith(".diff"));
      if (files.length > retention) {
        files.sort(); // unix_ms prefix sorts ascending = oldest first
        const drop = files.slice(0, files.length - retention);
        await Promise.all(drop.map((f) => unlink(join(dir, f)).catch(() => undefined)));
      }
    } catch {
      // sweep failure is non-fatal
    }

    return { id, path };
  } catch (err) {
    console.error(`[siltpoke] writeCriticSnapshot failed: ${err}`);
    return undefined;
  }
}
