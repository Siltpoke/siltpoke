// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /api/few-shot — few-shot index stats + optional neighbor query
 *
 * Query params:
 *   q  (optional) — query text; when present, returns top-k neighbors
 *   k  (default 3)
 */
import type { Hono } from "hono";
import { loadIndex } from "../../few-shot/index";
import { findNearest } from "../../few-shot/retriever";
import { createStubEmbedder } from "../../few-shot/embedder";

export function mountFewShotApiRoutes(app: Hono): void {
  app.get("/api/few-shot", async (c) => {
    const query = c.req.query("q") ?? null;
    const kParam = c.req.query("k");
    const k = Math.max(1, Math.min(10, Number(kParam) || 3));

    const index = await loadIndex();
    const totalEntries = index.length;
    const embeddingDim =
      index.length > 0 ? (index[0]?.embedding.length ?? 0) : 0;

    const timestamps = index.map((e) => e.ts).sort();
    const oldestTs = timestamps[0] ?? null;
    const newestTs = timestamps[timestamps.length - 1] ?? null;

    let neighbors: Array<{
      id: string;
      critique_summary: string;
      reason_text: string | null;
      ts: string;
      similarity: number;
    }> = [];

    if (query !== null && query.trim().length > 0 && index.length > 0) {
      const embedder = createStubEmbedder(embeddingDim || 384);
      const qe = await embedder.embed(query);
      const raw = findNearest(qe, index, k);
      neighbors = raw.map((n) => ({
        id: n.entry.id,
        critique_summary: n.entry.critique_summary,
        reason_text: n.entry.reason_text,
        ts: n.entry.ts,
        similarity: n.similarity,
      }));
    }

    return c.json({
      success: true,
      data: {
        totalEntries,
        embeddingDim,
        oldestTs,
        newestTs,
        neighbors,
      },
    });
  });
}
