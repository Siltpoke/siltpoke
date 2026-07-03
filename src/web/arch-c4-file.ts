// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Authored C4 model loader.
 *
 * The authored architecture model lives ON DISK in the TARGET repo at
 * `.siltpoke/arch-c4.json` — a versioned, reviewable property of the codebase
 * (docs-as-code), loaded at SSR and threaded to the island as props. Detection
 * is "file present", NEVER a repo-name match (the old name-keyed basename
 * check and its bundle constant are deleted; the guard test pins it).
 *
 * Hand-edited JSON is untrusted boundary input: Zod-validated (schema v1 =
 * serialized `C4Model` + a schemaVersion envelope). Malformed → `{ model: null,
 * invalid: true }` so the page fails SOFT to the derived cascade with a visible
 * notice — never a broken render, never silent.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { C4Model } from "./client/islands/repo-graph-c4-model";

export const ARCH_C4_FILENAME = ".siltpoke/arch-c4.json";

// NOTE: this schema HAND-MIRRORS the `C4Model` interface
// (client/islands/repo-graph-c4-model.ts) — a field added to the interface
// MUST be added here in the same commit, or shipped authored files validate
// against a stale shape. The model-integrity test loads the project's own
// real file through this loader, which catches a break on the shipped file at least.
const c4NodeSchema = z.object({
  kind: z.enum(["person", "ext", "cont"]),
  title: z.string(),
  tech: z.string().optional(),
  desc: z.string().optional(),
  accent: z.enum(["sky", "terra", "moss", "amber"]).optional(),
  comp: z.array(z.tuple([z.string(), z.string()])).optional(),
  drillTo: z.string().optional(),
  members: z.array(z.string()).optional(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

const archC4FileSchema = z.object({
  schemaVersion: z.literal(1),
  N: z.record(z.string(), c4NodeSchema),
  E: z.array(z.tuple([z.string(), z.string(), z.string()])),
  BANDS: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      w: z.number().positive(),
      h: z.number().positive(),
      label: z.string(),
      color: z.string(),
      lc: z.string(),
      note: z.string(),
      heuristic: z.boolean().optional(),
    }),
  ),
  BOUNDARY: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), label: z.string() }),
  GROUP_ACCENT: z.object({ sky: z.string(), terra: z.string(), moss: z.string(), amber: z.string() }),
});

export type AuthoredC4Result = {
  /** Parsed model, or null when absent OR invalid. */
  model: C4Model | null;
  /** True ONLY when a file exists but failed validation — drives the notice. */
  invalid: boolean;
};

/** Load + validate the repo's authored C4 model. Absent file = the normal
 * non-authored case (`{null, false}`); present-but-broken = `{null, true}`.
 * Async like every other I/O in the SSR route — never blocks the event loop. */
export async function loadAuthoredC4(projectRoot: string | null): Promise<AuthoredC4Result> {
  if (!projectRoot) return { model: null, invalid: false };
  const path = join(projectRoot, ARCH_C4_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { model: null, invalid: false }; // absent file — normal non-authored case
  }
  try {
    const raw = JSON.parse(text) as unknown;
    const parsed = archC4FileSchema.safeParse(raw);
    if (!parsed.success) return { model: null, invalid: true };
    const { schemaVersion: _v, ...model } = parsed.data;
    return { model: model as C4Model, invalid: false };
  } catch {
    return { model: null, invalid: true }; // unreadable / not JSON
  }
}
