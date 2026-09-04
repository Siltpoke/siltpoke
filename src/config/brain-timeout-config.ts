// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * How long one reviewer subprocess may run before siltpoke kills it.
 *
 * WHY THIS EXISTS. `DEFAULT_TIMEOUT_MS` is 90s and the number could not be
 * questioned without editing code. `brain.ts` does read
 * `SILTPOKE_BRAIN_TIMEOUT_MS`, but the Stop hook is spawned by the host and
 * does not inherit a shell's environment, so in practice nothing could move it.
 *
 * Measured across every trace on disk: **453 critic calls — 14.2% of all of
 * them — end at 89-92s**, killed by that timer, and that failure class carries
 * 0 retries plus a 15-60 minute breaker. Because the kill removes both the
 * duration and the output-token count, the right tail of the distribution is
 * CENSORED: how long those calls needed is not recoverable from the data. This
 * key exists so that question can be answered by running with a higher cap and
 * measuring, instead of guessing a new default.
 * (an internal design note §3.7-§3.9.)
 *
 * PRECEDENCE is `config > env > default`, which follows from
 * `resolveBrainTimeoutMs` treating an explicit argument as authoritative. When
 * the key is absent this returns `undefined`, so the env var keeps working
 * exactly as before for one-off overrides.
 *
 * BOUNDS. Floor 1s, so a mistyped value cannot make every review fail
 * instantly. Ceiling 600s, because the Stop hook blocks synchronously — a cap
 * above that freezes the user's terminal for longer than any review is worth.
 * An out-of-range or malformed value falls back to `undefined` (today's
 * behaviour) rather than throwing: this is read on the hook path, where a
 * config typo must not take the reviewer down with it.
 */
export const brainTimeoutConfigSchema = z.object({
  timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
});

export type BrainTimeoutConfig = z.infer<typeof brainTimeoutConfigSchema>;

/**
 * Load the `brain` section of `<home>/config.json`
 * (`{ "brain": { "timeout_ms": 180000 } }`), tolerant of a missing file / key /
 * malformed shape. Mirrors `loadDaemonConfig` / `loadCase1CaptureConfig`.
 *
 * Returns the millisecond value, or `undefined` when unset or unusable — which
 * is exactly what callers hand to `resolveBrainTimeoutMs`, so an absent key
 * means "fall through to env, then to the default".
 */
export async function loadBrainTimeoutMs(home: string): Promise<number | undefined> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { brain?: unknown };
    const result = brainTimeoutConfigSchema.safeParse(parsed.brain ?? {});
    return result.success ? result.data.timeout_ms : undefined;
  } catch {
    return undefined;
  }
}
