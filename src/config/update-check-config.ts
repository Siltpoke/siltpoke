// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Config for the once-a-day "is there a newer release?" check.
 *
 * `enabled` — default **true**. Default-off was considered and rejected: the
 * people this exists for are the ones who do not know an update is waiting, and
 * they are exactly the people who will never turn it on. 1.2.0 fixed a hook
 * that exited in silence every single turn; a user still on 1.1.0 has no way to
 * learn that from inside the product.
 *
 * What it sends: one GET for the latest released version number. Nothing about
 * the user, nothing about their code, and siltpoke receives nothing — the
 * request goes to GitHub, which sees it the way it would if the user opened the
 * releases page themselves. Offline, rate-limited or unreadable → silent skip.
 */
const updateCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

type UpdateCheckConfig = z.infer<typeof updateCheckConfigSchema>;

/**
 * Load the `updateCheck` section of `<home>/config.json`, tolerant of a missing
 * file / key / malformed shape (falls back to schema defaults).
 *
 * Sync on purpose: both callers — the doctor row and the SessionStart emitter —
 * sit on a hot path with nothing to await. An async twin was written first and
 * deleted: `audit:dead` caught that nothing but its own test ever called it.
 */
export function loadUpdateCheckConfigSync(
  home: string,
  readFileSyncFn: (p: string, enc: "utf8") => string,
): UpdateCheckConfig {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return updateCheckConfigSchema.parse({});
  try {
    return parseSection(readFileSyncFn(configPath, "utf8"));
  } catch {
    return updateCheckConfigSchema.parse({});
  }
}

function parseSection(raw: string): UpdateCheckConfig {
  const parsed = JSON.parse(raw) as { updateCheck?: unknown };
  const result = updateCheckConfigSchema.safeParse(parsed.updateCheck ?? {});
  return result.success ? result.data : updateCheckConfigSchema.parse({});
}
