// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Config for the opt-in forward-capture "case1" snapshot feature
 * (`captureCase1Pre` / `finalizeCase1` in `src/memory/case1-capture.ts`).
 *
 * `capture_case1` — whether the Stop hook may snapshot defect/fix file
 * content into `<stateBase>/case1-candidates/`. Default `false`: this is a
 * privacy surface (it persists raw file content from the user's worktree),
 * so it must be opt-in. `isCase1CaptureEnabled` additionally requires the
 * `SILTPOKE_CAPTURE_CASE1` env var to be truthy — belt-and-suspenders so a
 * stray/malicious `config.json` edit alone can't turn this on.
 */
export const case1CaptureConfigSchema = z.object({
  capture_case1: z.boolean().default(false),
});

export type Case1CaptureConfig = z.infer<typeof case1CaptureConfigSchema>;

/**
 * Load the `case1` section of `<home>/config.json`
 * (`{ "case1": { "capture_case1": true } }`), tolerant of a missing file /
 * key / malformed shape (falls back to schema defaults, i.e. OFF). Mirrors
 * the `loadDaemonConfig` pattern.
 */
export async function loadCase1CaptureConfig(home: string): Promise<Case1CaptureConfig> {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return case1CaptureConfigSchema.parse({});
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { case1?: unknown };
    const result = case1CaptureConfigSchema.safeParse(parsed.case1 ?? {});
    return result.success ? result.data : case1CaptureConfigSchema.parse({});
  } catch {
    return case1CaptureConfigSchema.parse({});
  }
}
