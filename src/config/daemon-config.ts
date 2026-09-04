// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Config for the optional background daemon (Hono server on 127.0.0.1:9876).
 *
 * `enabled` — whether the daemon should be autostarted / respawned. Default
 * `false`: core review runs entirely in the Stop hook process and never needs
 * the daemon; only the opt-in web surfaces (dashboard / chat / repo-index) do.
 * Turned on by opening `/siltpoke-dashboard`, which lazy-starts the server.
 */
export const daemonConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

/**
 * Load the `daemon` section of `<home>/config.json`, tolerant of a missing
 * file / key / malformed shape (falls back to schema defaults). Mirrors the
 * `loadIndexConfig` pattern.
 */
export async function loadDaemonConfig(home: string): Promise<DaemonConfig> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return daemonConfigSchema.parse({});
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { daemon?: unknown };
    const result = daemonConfigSchema.safeParse(parsed.daemon ?? {});
    return result.success ? result.data : daemonConfigSchema.parse({});
  } catch {
    return daemonConfigSchema.parse({});
  }
}
