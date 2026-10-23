import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createFastEmbedEmbedder } from "../../src/few-shot/embedder";

// [88] FlagEmbedding.init got no cacheDir, so the ~87 MB model landed in
// <cwd>/local_cache/ — one copy per project. The init must name a folder
// under Siltpoke's own data root. The library is stubbed: no download.

function stubLoader(calls: Array<Record<string, unknown>>) {
  return async () => ({
    EmbeddingModel: { AllMiniLML6V2: "fast-all-MiniLM-L6-v2" },
    FlagEmbedding: {
      async init(opts: Record<string, unknown>) {
        calls.push(opts);
        return {
          embed: () => ({
            next: async () => ({ done: false, value: [new Array(384).fill(0.5)] }),
          }),
        };
      },
    },
  });
}

test("[88] fastembed init gets an explicit cacheDir under the Siltpoke root, not under cwd", async () => {
  const localCacheBefore = existsSync(join(process.cwd(), "local_cache"));
  const home = mkdtempSync(join(tmpdir(), "siltpoke-88-"));
  const calls: Array<Record<string, unknown>> = [];
  const emb = await createFastEmbedEmbedder({
    env: { SILTPOKE_HOME: home },
    loadFastembed: stubLoader(calls),
  });
  expect(emb).not.toBeNull();
  expect(calls.length).toBe(1);
  const cacheDir = calls[0].cacheDir;
  expect(typeof cacheDir).toBe("string");
  const rel = relative(home, cacheDir as string);
  expect(rel.startsWith("..")).toBe(false);
  expect(isAbsolute(rel)).toBe(false);
  // absence: nothing under the working directory
  const underCwd = relative(process.cwd(), cacheDir as string);
  expect(underCwd.startsWith("..")).toBe(true);
  expect(existsSync(join(process.cwd(), "local_cache"))).toBe(localCacheBefore);
});

test("[88] cacheDir exists when init runs, even if the Siltpoke root does not yet", async () => {
  const base = mkdtempSync(join(tmpdir(), "siltpoke-88-"));
  const home = join(base, "not", "yet", "there");
  let existedAtInit = false;
  const emb = await createFastEmbedEmbedder({
    env: { SILTPOKE_HOME: home },
    loadFastembed: async () => ({
      EmbeddingModel: { AllMiniLML6V2: "m" },
      FlagEmbedding: {
        async init(o: { cacheDir: string }) {
          // fastembed's own mkdir is non-recursive; the folder must be there already
          existedAtInit = existsSync(o.cacheDir);
          return {
            embed: () => ({
              next: async () => ({ done: true, value: undefined }),
            }),
          };
        },
      },
    }),
  });
  expect(emb).not.toBeNull();
  expect(existedAtInit).toBe(true);
});

test("[88] a loader that throws still falls back (null)", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-88-"));
  const emb = await createFastEmbedEmbedder({
    env: { SILTPOKE_HOME: home },
    loadFastembed: async () => {
      throw new Error("Cannot find package 'fastembed'");
    },
  });
  expect(emb).toBeNull();
});

test("[88] a loader returning a module without FlagEmbedding still falls back (null)", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-88-"));
  const emb = await createFastEmbedEmbedder({
    env: { SILTPOKE_HOME: home },
    loadFastembed: async () => ({}),
  });
  expect(emb).toBeNull();
});
