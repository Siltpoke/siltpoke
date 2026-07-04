// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface Embedder {
  embed(text: string): Promise<number[]>;
  dimension: number;
}

/**
 * Stub: hash-based pseudo-embedding (deterministic, useful for tests + when fastembed absent).
 * Produces an L2-normalized vector of the requested dimension.
 */
export function createStubEmbedder(dim = 384): Embedder {
  return {
    dimension: dim,
    async embed(text: string): Promise<number[]> {
      // Hash text deterministically into dim values [-1, 1]
      const out = new Array(dim).fill(0);
      let seed = 0;
      for (let i = 0; i < text.length; i++)
        seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
      let x = seed >>> 0;
      for (let i = 0; i < dim; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        out[i] = (x / 0xffffffff) * 2 - 1;
      }
      // L2-normalize
      const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0));
      return out.map((v) => v / (norm || 1));
    },
  };
}

/**
 * Real fastembed embedder (lazy import) — only if the package is available.
 * Returns null when fastembed is absent so the caller can fall back to the stub.
 */
export async function createFastEmbedEmbedder(): Promise<Embedder | null> {
  try {
    // @ts-ignore - dynamic import; package may not be present
    const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
    const model = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2,
    });
    return {
      dimension: 384,
      async embed(text: string): Promise<number[]> {
        const it = model.embed([text]);
        const result = await it.next();
        if (result.done) return new Array(384).fill(0);
        return Array.from(result.value[0]);
      },
    };
  } catch {
    return null;
  }
}

/**
 * Returns a real fastembed embedder when available, otherwise falls back to the stub.
 */
export async function defaultEmbedder(): Promise<Embedder> {
  // `SILTPOKE_EMBED_STUB=1` forces the deterministic stub — skips loading the
  // native fastembed/onnxruntime model. Used by tests: real ONNX is slow,
  // non-deterministic, and segfaults the `bun test` runner when loaded
  // alongside the other native modules (tree-sitter) in the demo-seed path.
  if (process.env.SILTPOKE_EMBED_STUB === "1") {
    return createStubEmbedder();
  }
  const real = await createFastEmbedEmbedder();
  return real ?? createStubEmbedder();
}
