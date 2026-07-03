// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { FewShotIndexEntry } from "./types";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface NeighborResult {
  entry: FewShotIndexEntry;
  similarity: number;
}

/**
 * Find the k nearest entries in the index to the query embedding using cosine similarity.
 */
export function findNearest(
  queryEmbedding: number[],
  index: FewShotIndexEntry[],
  k = 3,
): NeighborResult[] {
  return index
    .map((entry) => ({
      entry,
      similarity: cosine(queryEmbedding, entry.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}
