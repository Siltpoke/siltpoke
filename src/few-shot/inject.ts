// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { Embedder } from "./embedder";
import { defaultEmbedder } from "./embedder";
import { loadIndex } from "./index";
import { findNearest } from "./retriever";

/** Only inject after at least this many dismissed entries have been logged. */
const MIN_ENTRIES = 10;

/** Gate weak matches — below this similarity threshold entries are excluded. */
const MIN_SIMILARITY = 0.5;

export interface GetAntiExamplesOpts {
  indexPath?: string;
  embedder?: Embedder;
}

/**
 * Retrieve k nearest dismissed critiques from the preference index and format
 * them as anti-example strings ready for prompt injection.
 *
 * Returns an empty array when the index is too small (< MIN_ENTRIES) or when
 * no neighbors exceed the MIN_SIMILARITY threshold.
 */
export async function getAntiExamples(
  queryText: string,
  k = 3,
  opts: GetAntiExamplesOpts = {},
): Promise<string[]> {
  const index = await loadIndex(opts.indexPath);
  if (index.length < MIN_ENTRIES) return [];

  const embedder = opts.embedder ?? (await defaultEmbedder());
  const qe = await embedder.embed(queryText);
  const neighbors = findNearest(qe, index, k);

  return neighbors
    .filter((n) => n.similarity >= MIN_SIMILARITY)
    .map(
      (n) =>
        `[Dismissed earlier — similarity ${n.similarity.toFixed(2)}] ${n.entry.critique_summary}${
          n.entry.reason_text ? ` Reason: ${n.entry.reason_text}` : ""
        }`,
    );
}

/**
 * Build the full anti-examples prompt block for injection into the Brain system prompt.
 * Returns an empty string when there are no relevant anti-examples.
 */
export async function buildAntiExamplesBlock(
  queryText: string,
  k = 3,
  opts: GetAntiExamplesOpts = {},
): Promise<string> {
  const examples = await getAntiExamples(queryText, k, opts);
  if (examples.length === 0) return "";
  return `## User dismissed similar past critiques\n${examples.join("\n\n")}`;
}
