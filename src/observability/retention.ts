// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Trace retention — evict old trace data by age and total size cap.
 *
 * runRetention():
 *   1. Delete any unit whose date is older than retentionDays.
 *   2. If total remaining size > maxStorageMB, delete oldest units first until
 *      under cap.
 *
 * A "unit" is either a top-level `<YYYY-MM-DD>.jsonl` span file or a
 * `spillover/<YYYY-MM-DD>/` directory. BOTH are covered because the spillover
 * subtree is where the bytes actually are: `Tracer.writeSpillover` parks every
 * setInput/setOutput payload over 8 KB there, and a single review can spill a
 * whole git diff. Measured on the author's machine 2026-08-23, `traces/` held
 * 2.0 GB of which `spillover/` was 1.8 GB — 84 day-directories reaching back to
 * 2026-05-21, none ever evicted, because this function only matched
 * `^\d{4}-\d{2}-\d{2}\.jsonl$` at the top level. That blindness defeated the age
 * cutoff and the size cap alike: the cap is computed from the surviving units,
 * so 1.8 GB of spillover never counted against a 500 MB limit.
 *
 * Returns counts of deleted files and freed bytes for logging. A spillover
 * day-directory counts as the number of files it held, not as one.
 */
import { readdirSync, statSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { siltpokeRoot } from "../installer/paths";

const DEFAULT_TRACES_DIR = join(siltpokeRoot(), "traces");

export interface RetentionOptions {
  dir?: string;
  retentionDays?: number;
  /**
   * Byte ceiling across everything retention owns. **Omitted means no size
   * eviction at all** — not a default number.
   *
   * Age is the primary policy and the one a user reasons about; the size cap
   * is an escape valve for a directory growing faster than the window drains
   * it. It used to default to 500 MB, which was harmless only because the
   * sweep never ran. The first time it did run — 2026-08-23 — the operator had
   * set `retention_days: 120` to hold a research corpus open and had never
   * heard of the second key; the unchosen 500 evicted ~1.4 GB inside that
   * window, and nothing logged it. An escape valve must not fire on a number
   * nobody picked, so this is now opt-in and the caller decides.
   */
  maxStorageMB?: number;
}

export interface RetentionResult {
  deletedFiles: number;
  freedBytes: number;
}

interface FileEntry {
  path: string;
  date: string;
  sizeBytes: number;
  /** How many files this unit removes — 1 for a JSONL, N for a spillover day. */
  fileCount: number;
  kind: "jsonl" | "spillover-day";
}

/** Parse YYYY-MM-DD from a filename like "2024-01-15.jsonl". Returns null if not a date file. */
function parseDateFromFile(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return m ? m[1] : null;
}

/** Parse YYYY-MM-DD from a bare directory name. Returns null if not a date dir. */
function parseDateFromDir(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

/**
 * Total size + file count of one spillover day-directory. Recurses, because
 * nothing guarantees the layout stays flat. A file that vanishes or cannot be
 * stat'd mid-walk is skipped rather than aborting the sweep — retention is
 * best-effort and runs against a directory the daemon is still writing to.
 */
function measureDir(dir: string): { sizeBytes: number; fileCount: number } {
  let sizeBytes = 0;
  let fileCount = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { sizeBytes, fileCount };
  }
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        const inner = measureDir(full);
        sizeBytes += inner.sizeBytes;
        fileCount += inner.fileCount;
      } else {
        sizeBytes += st.size;
        fileCount++;
      }
    } catch {
      // Skip this entry — it vanished or is unreadable. The sweep runs against
      // a directory the daemon is still writing to, so that is expected.
    }
  }
  return { sizeBytes, fileCount };
}

/** Delete one retention unit. Returns false when nothing could be removed. */
function removeEntry(entry: FileEntry): boolean {
  try {
    if (entry.kind === "spillover-day") {
      rmSync(entry.path, { recursive: true, force: true });
    } else {
      unlinkSync(entry.path);
    }
    return true;
  } catch {
    return false;
  }
}

export function runRetention(opts: RetentionOptions = {}): RetentionResult {
  const dir = opts.dir ?? DEFAULT_TRACES_DIR;
  const retentionDays = opts.retentionDays ?? 30;
  const maxStorageMB = opts.maxStorageMB;

  if (!existsSync(dir)) {
    return { deletedFiles: 0, freedBytes: 0 };
  }

  let deletedFiles = 0;
  let freedBytes = 0;

  // Cutoff date: files strictly older than retentionDays days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Collect all date-named JSONL files. `existsSync` above is true for a plain
  // FILE and for a directory this process cannot read, so this call can still
  // throw ENOTDIR / EACCES. It is now on the daemon's boot path, where a throw
  // means the daemon does not start at all — it leaves a stale lock + pidfile
  // and crash-flaps under launchd `KeepAlive`. A trace directory that cannot be
  // read is a reason to evict nothing, never a reason to take siltpoke down.
  let topLevelNames: string[];
  try {
    topLevelNames = readdirSync(dir);
  } catch {
    return { deletedFiles: 0, freedBytes: 0 };
  }
  let entries: FileEntry[] = [];
  for (const name of topLevelNames) {
    const dateStr = parseDateFromFile(name);
    if (!dateStr) continue;
    const fullPath = join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(fullPath).size;
    } catch {
      continue;
    }
    entries.push({ path: fullPath, date: dateStr, sizeBytes, fileCount: 1, kind: "jsonl" });
  }

  // Collect spillover day-directories. Anything under spillover/ that is not a
  // bare YYYY-MM-DD directory is left alone — retention owns the day-partitions
  // Tracer creates, not whatever else a user parks there.
  const spilloverRoot = join(dir, "spillover");
  if (existsSync(spilloverRoot)) {
    let names: string[] = [];
    try {
      names = readdirSync(spilloverRoot);
    } catch {
      names = [];
    }
    for (const name of names) {
      const dateStr = parseDateFromDir(name);
      if (!dateStr) continue;
      const fullPath = join(spilloverRoot, name);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const { sizeBytes, fileCount } = measureDir(fullPath);
      entries.push({ path: fullPath, date: dateStr, sizeBytes, fileCount, kind: "spillover-day" });
    }
  }

  // Delete units older than cutoff
  for (const entry of entries) {
    if (entry.date < cutoffStr) {
      if (removeEntry(entry)) {
        deletedFiles += entry.fileCount;
        freedBytes += entry.sizeBytes;
      }
    }
  }

  // Recalculate surviving entries after the cutoff pass
  entries = entries.filter(e => e.date >= cutoffStr && existsSync(e.path));

  // Size cap — opt-in. With no cap configured this pass does not run, and age
  // is the only thing that deletes (see RetentionOptions.maxStorageMB).
  const maxBytes = maxStorageMB === undefined ? null : maxStorageMB * 1024 * 1024;
  let totalBytes = entries.reduce((acc, e) => acc + e.sizeBytes, 0);

  if (maxBytes !== null && totalBytes > maxBytes) {
    // Sort ascending by date (oldest first), and within one day put the
    // spillover ahead of the JSONL: the payloads are what the cap is chasing,
    // so evicting them often gets under the limit while leaving that day's
    // span file — the small, structured half — readable.
    entries.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === "spillover-day" ? -1 : 1),
    );
    for (const entry of entries) {
      if (totalBytes <= maxBytes) break;
      if (removeEntry(entry)) {
        deletedFiles += entry.fileCount;
        freedBytes += entry.sizeBytes;
        totalBytes -= entry.sizeBytes;
      }
    }
  }

  return { deletedFiles, freedBytes };
}
