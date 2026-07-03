// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Config for the in-dashboard "Index a repo" trigger.
 *
 * `allowRoots` — directories under which a path may be indexed. Empty (the
 * default) means "use `$HOME`" (resolved by `resolveAllowRoots`). This is the
 * defense-in-depth bound on the new trust boundary: even with the daemon
 * secret, a browser-reachable endpoint must not be able to index `/etc`,
 * `~/.ssh`, or another user's home. Widen it here if code lives outside `~`.
 * `timeoutMs` — hard wall-clock cap on the indexer subprocess.
 */
export const indexConfigSchema = z.object({
  allowRoots: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600_000),
});

export type IndexConfig = z.infer<typeof indexConfigSchema>;

/** Effective allow-roots: configured list, or `[$HOME]` when none set. */
export function resolveAllowRoots(cfg: IndexConfig): string[] {
  return cfg.allowRoots.length > 0 ? cfg.allowRoots : [homedir()];
}

/**
 * Load the `index` section of `<home>/config.json`, tolerant of a missing file
 * / missing key / malformed shape (falls back to schema defaults). Mirrors the
 * `loadCostConfig` pattern.
 */
export async function loadIndexConfig(home: string): Promise<IndexConfig> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return indexConfigSchema.parse({});
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { index?: unknown };
    const result = indexConfigSchema.safeParse(parsed.index ?? {});
    return result.success ? result.data : indexConfigSchema.parse({});
  } catch {
    return indexConfigSchema.parse({});
  }
}
