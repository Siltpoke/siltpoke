// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { sha256, getCached, setCached } from "./cache.ts";

export type SummarizeFn = (source: string, path: string) => Promise<string>;

// Default stub: produces a deterministic summary from source heuristics
// (real impl would call Haiku via spawn brain.ts)
export async function stubSummarize(source: string, path: string): Promise<string> {
  const lines = source.split("\n");
  const exports = lines.filter((l) => /^export /.test(l)).slice(0, 5);
  const imports = lines.filter((l) => /^import /.test(l)).slice(0, 3);
  return [
    `# ${path}`,
    ``,
    `**Lines:** ${lines.length}`,
    ``,
    `## Imports`,
    ...imports.map((i) => `- ${i}`),
    ``,
    `## Exports`,
    ...exports.map((e) => `- ${e}`),
  ].join("\n");
}

export async function summarizeFile(
  source: string,
  path: string,
  opts: { cacheDir: string; summarize?: SummarizeFn },
): Promise<{ summary: string; hash: string; cached: boolean }> {
  const hash = sha256(source);
  const cached = await getCached(opts.cacheDir, hash);
  if (cached) return { summary: cached, hash, cached: true };
  const summarize = opts.summarize ?? stubSummarize;
  const summary = await summarize(source, path);
  await setCached(opts.cacheDir, hash, summary);
  return { summary, hash, cached: false };
}
