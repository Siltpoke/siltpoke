// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  findCritiqueByIdOrLatest,
  readStatus,
  setStatus,
} from "../state/critique-status";
import {
  addXp,
  readProgression,
  writeProgression,
} from "../state/progression";
import { appendPreferenceEntry } from "../preference-log/writer";

export const FORWARD_XP_REWARD = 10;

export interface MarkForwardedOptions {
  // Per-project base (where critiques live) — typically {cwd}/.siltpoke/.
  basePath: string;
  // Global base (where progression lives) — typically ~/.siltpoke/.
  // XP is intentionally cross-project: pet leveling is a single global pet.
  homeBase?: string;
  idOrLatest: string;
  // Override preference-log path (for test isolation). When unset, the writer's
  // global default (~/.siltpoke/preference-log.jsonl) is used.
  preferenceLogPath?: string;
}

export async function markForwarded(
  opts: MarkForwardedOptions,
): Promise<string> {
  const homeBase =
    opts.homeBase ?? join(process.env.HOME ?? "", ".siltpoke");
  const path = await findCritiqueByIdOrLatest(opts.basePath, opts.idOrLatest);
  if (!path) {
    return `# Siltpoke: critique '${opts.idOrLatest}' not found.\n`;
  }
  const before = await readStatus(path);
  const alreadyForwarded = before === "forwarded";
  const ok = await setStatus(path, "forwarded");
  if (!ok) {
    return `# Siltpoke: failed to update status at ${path}.\n`;
  }
  if (!alreadyForwarded) {
    const current = await readProgression(homeBase);
    const result = addXp(current, FORWARD_XP_REWARD);
    await writeProgression(homeBase, result.next);
  }

  let critiqueSnapshot: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    critiqueSnapshot = { raw_md: raw };
  } catch {
    // best-effort snapshot
  }
  appendPreferenceEntry(
    {
      critique_id: opts.idOrLatest,
      signal: "forward",
      reason_text: null,
      critique_snapshot: critiqueSnapshot,
      diff_snapshot_sha: null,
      intent_at_critique: null,
      reflexion_rule_fired: null,
    },
    opts.preferenceLogPath ? { path: opts.preferenceLogPath } : undefined,
  ).catch(() => {
    // preference log is non-fatal
  });

  const xpNote = alreadyForwarded ? "" : ` (+${FORWARD_XP_REWARD} XP)`;
  return `# Siltpoke: critique '${opts.idOrLatest}' marked forwarded${xpNote}.\n`;
}

if (import.meta.main) {
  const idOrLatest = process.argv[2] ?? "latest";
  const basePath = join(process.cwd(), ".siltpoke");
  const out = await markForwarded({ basePath, idOrLatest });
  process.stdout.write(out);
  process.exit(0);
}
