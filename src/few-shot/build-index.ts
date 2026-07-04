// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readPreferenceLog } from "../preference-log/reader";
import { defaultEmbedder } from "./embedder";
import type { Embedder } from "./embedder";
import { saveIndex, loadIndex } from "./index";
import type { FewShotIndexEntry } from "./types";

export interface BuildOpts {
  preferenceLogPath?: string;
  indexPath?: string;
  embedder?: Embedder;
}

export interface BuildResult {
  entriesAdded: number;
  totalEntries: number;
}

/**
 * Build (or incrementally update) the few-shot index from dismissed preference log entries.
 * Already-indexed critique IDs are skipped to avoid duplicate embeddings.
 */
export async function buildFewShotIndex(opts: BuildOpts = {}): Promise<BuildResult> {
  const existing = await loadIndex(opts.indexPath);
  const existingIds = new Set(existing.map((e) => e.id));

  const entries = await readPreferenceLog({
    path: opts.preferenceLogPath,
    signal: "dismiss",
  });

  const embedder = opts.embedder ?? (await defaultEmbedder());

  const newEntries: FewShotIndexEntry[] = [];
  for (const e of entries) {
    if (existingIds.has(e.critique_id)) continue;

    const text =
      (e.reason_text ?? "") +
      " " +
      JSON.stringify(e.critique_snapshot ?? {}).slice(0, 1000);

    const embedding = await embedder.embed(text);

    newEntries.push({
      id: e.critique_id,
      embedding,
      signal: "dismiss",
      reason_text: e.reason_text,
      critique_summary: text.slice(0, 200),
      ts: e.ts,
    });
  }

  const merged = [...existing, ...newEntries];
  await saveIndex(merged, opts.indexPath);

  return { entriesAdded: newEntries.length, totalEntries: merged.length };
}
