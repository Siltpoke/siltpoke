// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Trace retention — evict old JSONL files by age and total size cap.
 *
 * runRetention():
 *   1. Delete any *.jsonl files whose filename date is older than retentionDays.
 *   2. If total remaining size > maxStorageMB, delete oldest files first until
 *      under cap.
 *
 * Returns counts of deleted files and freed bytes for logging.
 */
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TRACES_DIR = join(homedir(), ".siltpoke", "traces");

export interface RetentionOptions {
  dir?: string;
  retentionDays?: number;
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
}

/** Parse YYYY-MM-DD from a filename like "2024-01-15.jsonl". Returns null if not a date file. */
function parseDateFromFile(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return m ? m[1] : null;
}

export function runRetention(opts: RetentionOptions = {}): RetentionResult {
  const dir = opts.dir ?? DEFAULT_TRACES_DIR;
  const retentionDays = opts.retentionDays ?? 30;
  const maxStorageMB = opts.maxStorageMB ?? 500;

  if (!existsSync(dir)) {
    return { deletedFiles: 0, freedBytes: 0 };
  }

  let deletedFiles = 0;
  let freedBytes = 0;

  // Cutoff date: files strictly older than retentionDays days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Collect all date-named JSONL files
  let entries: FileEntry[] = [];
  for (const name of readdirSync(dir)) {
    const dateStr = parseDateFromFile(name);
    if (!dateStr) continue;
    const fullPath = join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(fullPath).size;
    } catch {
      continue;
    }
    entries.push({ path: fullPath, date: dateStr, sizeBytes });
  }

  // Delete files older than cutoff
  for (const entry of entries) {
    if (entry.date < cutoffStr) {
      try {
        unlinkSync(entry.path);
        deletedFiles++;
        freedBytes += entry.sizeBytes;
      } catch {
        // Best effort
      }
    }
  }

  // Recalculate surviving entries after the cutoff pass
  entries = entries.filter(e => e.date >= cutoffStr && existsSync(e.path));

  // Size cap — delete oldest first until under maxStorageMB
  const maxBytes = maxStorageMB * 1024 * 1024;
  let totalBytes = entries.reduce((acc, e) => acc + e.sizeBytes, 0);

  if (totalBytes > maxBytes) {
    // Sort ascending by date (oldest first)
    entries.sort((a, b) => a.date.localeCompare(b.date));
    for (const entry of entries) {
      if (totalBytes <= maxBytes) break;
      try {
        unlinkSync(entry.path);
        deletedFiles++;
        freedBytes += entry.sizeBytes;
        totalBytes -= entry.sizeBytes;
      } catch {
        // Best effort
      }
    }
  }

  return { deletedFiles, freedBytes };
}
