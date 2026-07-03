// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface FeedbackArchiveEntry {
  ts: string;
  critique_id: string;
  /** "undismissed" added in v1.1-J as the reverse of "dismissed". */
  verdict: "dismissed" | "forwarded" | "acked" | "undismissed";
  reason: string | null;
  reflection?: {
    rule_id: string | null;
    rule_category: string | null;
    confidence: string | null;
    /**
     * v1.1-J — true iff THIS dismissal appended a NEW learned_rule to
     * memory.json. False when the reflection matched an existing rule
     * (duplicate, rule belongs to another critique). Undefined on legacy
     * entries written before v1.1-J — callers fall back to a
     * chronological scan to infer ownership.
     */
    rule_created?: boolean;
  };
  /**
   * v1.1-J — when verdict === "undismissed", this points at the
   * original "dismissed" entry being reversed. Same as `critique_id`
   * (a critique can only be undismissed once before being re-dismissed).
   */
  reverses_critique_id?: string;
}

const FILENAME = "feedback-archive.jsonl";

export function feedbackArchivePath(basePath: string): string {
  return join(basePath, FILENAME);
}

export async function appendFeedbackArchive(
  basePath: string,
  entry: FeedbackArchiveEntry,
): Promise<void> {
  try {
    await mkdir(basePath, { recursive: true });
    await appendFile(
      feedbackArchivePath(basePath),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  } catch {
    // never crash the caller — archive is best-effort
  }
}

/**
 * Read the feedback archive line-by-line. Returns entries in file order
 * (chronologically oldest → newest, since file is append-only).
 * Tolerant of malformed lines (skipped silently).
 */
export async function readFeedbackArchive(
  basePath: string,
): Promise<FeedbackArchiveEntry[]> {
  const path = feedbackArchivePath(basePath);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const entries: FeedbackArchiveEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as FeedbackArchiveEntry;
      if (typeof parsed.critique_id === "string" && typeof parsed.verdict === "string") {
        entries.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/**
 * Find the most recent "dismissed" archive entry for a critique id.
 * Returns null when no dismissal has been recorded for that id.
 *
 * Used by v1.1-J undismiss to recover the original dismissal's
 * `reflection.rule_id` + `rule_created` flag.
 */
export async function findDismissalEntry(
  basePath: string,
  critique_id: string,
): Promise<FeedbackArchiveEntry | null> {
  const all = await readFeedbackArchive(basePath);
  // Scan newest-first so we return the latest dismissal (in case the
  // critique was dismissed → undismissed → dismissed again).
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i]!;
    if (e.critique_id === critique_id && e.verdict === "dismissed") {
      return e;
    }
  }
  return null;
}
