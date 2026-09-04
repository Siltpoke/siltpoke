// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * How long trace data is kept, and how much of it fits on disk.
 *
 * WHY THIS EXISTS. Both numbers were hardcoded at the single call site in
 * `src/daemon/server.ts` (30 days / 500 MB) and could not be moved without
 * editing code. That mattered the moment the sweep was repaired: retention had
 * never once run, so `~/.siltpoke/traces` was holding 2.0 GB reaching back 94
 * days — and turning a working eviction loose on it would have deleted the
 * corpus that every measurement in
 * an internal design note was computed from.
 * A key lets that corpus be held open while the investigation runs, then
 * released, without a code change either way.
 *
 * BOUNDS. `retention_days` floor 1 — zero would evict today's spans mid-write.
 * Ceiling 3650, past which "keep it" is the honest configuration.
 * `max_storage_mb` floor 1, ceiling 1_000_000 (1 TB).
 *
 * An out-of-range or malformed value falls back to `undefined` — the caller's
 * default — rather than throwing. This is read on the daemon boot path, where
 * a config typo must not stop the daemon from starting.
 */
export const tracesRetentionConfigSchema = z.object({
  retention_days: z.number().int().min(1).max(3650).optional(),
  max_storage_mb: z.number().int().min(1).max(1_000_000).optional(),
});

export type TracesRetentionConfig = z.infer<typeof tracesRetentionConfigSchema>;

export interface LoadTracesRetentionOptions {
  /**
   * Called once per key whose value was present but rejected, with a
   * human-readable reason. Defaults to `console.error`.
   *
   * This exists because the fallback direction is destructive: a rejected
   * `retention_days` reverts to a SHORTER window, so a silent degrade deletes
   * more data than the user asked to keep. On 2026-08-23 that cost ~1.4 GB
   * with no warning anywhere. A caller that genuinely wants silence passes a
   * no-op; nobody gets it by default.
   */
  onReject?: (message: string) => void;
}

/**
 * Load the `traces` section of `<home>/config.json`
 * (`{ "traces": { "retention_days": 120, "max_storage_mb": 4000 } }`), tolerant
 * of a missing file / key / malformed shape.
 *
 * Returns `{}` when unset or unusable, so a caller can spread it over its own
 * defaults and an absent key means "keep today's behaviour".
 *
 * **Each key is parsed independently, deliberately.** The obvious shape — one
 * `safeParse` over the whole section, as `loadBrainTimeoutMs` does — is
 * object-level, so ONE rejected field discards the section and reverts BOTH
 * keys to their defaults. That is defensible for a single-key timeout, where
 * the degraded outcome is a slower review. Here the degraded outcome is
 * deletion: `{ retention_days: 120, max_storage_mb: 0 }` would have thrown away
 * the 120 along with the 0 and taken the window back to 30 days. `max_storage_mb: 0`
 * is a plausible "no limit" typo, which is how a typo in one key ends up
 * deleting three months of data configured by the other.
 */
export async function loadTracesRetentionConfig(
  home: string,
  opts: LoadTracesRetentionOptions = {},
): Promise<TracesRetentionConfig> {
  const onReject = opts.onReject ?? ((m: string) => console.error(m));
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return {};

  let section: unknown;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { traces?: unknown };
    section = parsed.traces;
  } catch {
    return {};
  }

  if (section === undefined || section === null) return {};
  if (typeof section !== "object" || Array.isArray(section)) {
    onReject(`[siltpoke] config.json: "traces" must be an object — ignoring it`);
    return {};
  }

  const record = section as Record<string, unknown>;
  const out: TracesRetentionConfig = {};
  for (const key of RETENTION_KEYS) {
    const value = parseKey(key, record[key], onReject);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const RETENTION_KEYS = ["retention_days", "max_storage_mb"] as const;

/**
 * Validate one key on its own. Returns `undefined` for absent-or-rejected, and
 * says so out loud when a value was present but unusable.
 */
function parseKey(
  key: (typeof RETENTION_KEYS)[number],
  value: unknown,
  onReject: (message: string) => void,
): number | undefined {
  if (value === undefined) return undefined;
  const result = tracesRetentionConfigSchema.shape[key].safeParse(value);
  if (result.success) return result.data;
  onReject(
    `[siltpoke] config.json: traces.${key} = ${JSON.stringify(value)} is not usable ` +
      `(${result.error.issues[0]?.message ?? "invalid"}) — ` +
      `falling back to the default, which retains LESS data`,
  );
  return undefined;
}
