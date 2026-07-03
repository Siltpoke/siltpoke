// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * critique-feedback — per-critique user notes with append-only edit history.
 *
 * Storage: ~/.siltpoke/critique-feedback.jsonl
 *   Each line is a `FeedbackEntry`. The latest entry for a critique_id wins
 *   for display; older entries are preserved as the edit log. Empty `text`
 *   is intentional — it means "user cleared the note". There is no
 *   separate delete action.
 *
 * Future: brain prompt assembly can pull recent (action=ack|dismiss)
 *   entries to feed back into the model as preference signals.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type FeedbackAction = "edit" | "ack" | "dismiss";

export interface FeedbackEntry {
  critique_id: string;
  ts: string;               // ISO write time
  text: string;             // user's note (empty allowed)
  action: FeedbackAction;
}

const FILE_NAME = "critique-feedback.jsonl";

export function feedbackPath(basePath: string): string {
  return join(basePath, FILE_NAME);
}

/**
 * Append a feedback entry. Creates the file/dir if missing.
 * Fail-soft is the caller's responsibility — this throws on fs errors so
 * route handlers can surface 5xx.
 */
export async function appendFeedback(
  basePath: string,
  entry: FeedbackEntry,
): Promise<void> {
  await mkdir(basePath, { recursive: true });
  await appendFile(feedbackPath(basePath), `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Read the full append-only history for one critique_id, oldest → newest.
 * Returns empty array when the file doesn't exist or has no matching rows.
 */
export async function readFeedbackHistory(
  basePath: string,
  critiqueId: string,
): Promise<FeedbackEntry[]> {
  const path = feedbackPath(basePath);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: FeedbackEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as Partial<FeedbackEntry>;
      if (ev.critique_id !== critiqueId) continue;
      if (typeof ev.ts !== "string" || typeof ev.text !== "string") continue;
      if (ev.action !== "edit" && ev.action !== "ack" && ev.action !== "dismiss") continue;
      out.push({
        critique_id: critiqueId,
        ts: ev.ts,
        text: ev.text,
        action: ev.action,
      });
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Convenience: return the latest entry's text for a critique, or null when
 * no history exists. Empty string is a valid latest (user cleared the
 * note); callers should distinguish "" from null.
 */
export async function latestFeedbackText(
  basePath: string,
  critiqueId: string,
): Promise<string | null> {
  const history = await readFeedbackHistory(basePath, critiqueId);
  if (history.length === 0) return null;
  return history[history.length - 1]?.text;
}
