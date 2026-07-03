// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /few-shot SSR route.
 *
 * GET /few-shot          — stats view
 * GET /few-shot?q=<text> — stats + top-3 anti-example neighbors
 */
import type { Hono } from "hono";
import { Layout } from "../_shared/layout";
import { FewShotScreen } from "../screens/FewShotScreen";
import type { NeighborResult } from "../screens/FewShotScreen";
import { loadIndex } from "../../few-shot/index";
import { findNearest } from "../../few-shot/retriever";
import { createStubEmbedder } from "../../few-shot/embedder";

export function mountFewShotRoutes(app: Hono): void {
  app.get("/few-shot", async (c) => {
    const query = c.req.query("q") ?? null;
    const index = await loadIndex();

    const totalEntries = index.length;
    const embeddingDim =
      index.length > 0 ? (index[0]?.embedding.length ?? 0) : 0;

    const timestamps = index.map((e) => e.ts).sort();
    const oldestTs = timestamps[0] ?? null;
    const newestTs = timestamps[timestamps.length - 1] ?? null;

    let neighbors: NeighborResult[] = [];
    if (query !== null && query.trim().length > 0 && index.length > 0) {
      const embedder = createStubEmbedder(embeddingDim || 384);
      const qe = await embedder.embed(query);
      const raw = findNearest(qe, index, 3);
      neighbors = raw.map((n) => ({
        id: n.entry.id,
        critique_summary: n.entry.critique_summary,
        reason_text: n.entry.reason_text,
        ts: n.entry.ts,
        similarity: n.similarity,
      }));
    }

    return c.html(
      <Layout title="few-shot · siltpoke">
        <FewShotScreen
          totalEntries={totalEntries}
          embeddingDim={embeddingDim}
          oldestTs={oldestTs}
          newestTs={newestTs}
          query={query}
          neighbors={neighbors}
        />
      </Layout>,
    );
  });
}
