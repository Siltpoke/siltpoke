// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { appendFile, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const TTL_HOOKS = 3;
export const TTL_DAYS = 2;

const pendingAnchorSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  tool: z.enum(["tsc", "eslint", "git-diff", "ripgrep"]),
  fingerprint: z.string(),
});

export const pendingCritiqueSchema = z.object({
  critique_id: z.string(),
  session_id: z.string(),
  created_sha: z.string().nullable(),
  created_at: z.string(),
  hooks_elapsed: z.number().int().nonnegative(),
  status: z.enum(["pending", "acted", "expired"]),
  severity: z.enum(["info", "low", "medium", "high"]),
  finding_text: z.string(),
  anchors: z.array(pendingAnchorSchema),
  distil_attempts: z.number().int().nonnegative().default(0),
  capture_id: z.string().regex(/^case1-[a-f0-9]+$/).optional(),
});
export type PendingCritique = z.infer<typeof pendingCritiqueSchema>;

/**
 * Path helper — the queue lives directly in the `.siltpoke` state dir, next to
 * baseline.json. `stateBase` is already the `.siltpoke` dir — do NOT re-suffix.
 */
export function pendingQueuePath(stateBase: string): string {
  return join(stateBase, "pending-critiques.jsonl");
}

export async function enqueuePending(queuePath: string, entry: PendingCritique): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  await appendFile(queuePath, JSON.stringify(entry) + "\n");
}

export async function readPending(queuePath: string): Promise<PendingCritique[]> {
  let text: string;
  try {
    text = await readFile(queuePath, "utf8");
  } catch {
    return [];
  }
  const out: PendingCritique[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(pendingCritiqueSchema.parse(JSON.parse(line)));
    } catch {
      // skip the corrupt line — degrade, never crash the hook
    }
  }
  return out;
}

export async function writePending(queuePath: string, entries: PendingCritique[]): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  const tmp = queuePath + "." + randomBytes(6).toString("hex") + ".tmp";
  await writeFile(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  await rename(tmp, queuePath);
}
