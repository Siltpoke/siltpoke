// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** `repo_graph` config section. `staleness_warn_pct` gates the stale verdict. */
export const repoGraphConfigSchema = z.object({
  staleness_warn_pct: z.number().min(0).max(1).default(0.2),
});
export type RepoGraphConfig = z.infer<typeof repoGraphConfigSchema>;

/** Load the `repo_graph` section of `<home>/config.json`; tolerant of missing
 *  file / key / malformed shape (falls back to defaults). Mirrors loadIndexConfig. */
export async function loadRepoGraphConfig(home: string): Promise<RepoGraphConfig> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return repoGraphConfigSchema.parse({});
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { repo_graph?: unknown };
    const result = repoGraphConfigSchema.safeParse(parsed.repo_graph ?? {});
    return result.success ? result.data : repoGraphConfigSchema.parse({});
  } catch {
    return repoGraphConfigSchema.parse({});
  }
}
