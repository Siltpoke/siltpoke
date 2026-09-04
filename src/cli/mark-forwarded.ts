// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  findCritiqueByIdOrLatest,
  readCritiqueId,
  readStatus,
  setStatus,
} from "../state/critique-status";
import {
  addXp,
  readProgression,
  writeProgression,
} from "../state/progression";
import { appendPreferenceEntry } from "../preference-log/writer";
import { siltpokeRoot } from "../installer/paths";

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
  const homeBase = opts.homeBase ?? siltpokeRoot();
  const path = await findCritiqueByIdOrLatest(opts.basePath, opts.idOrLatest);
  if (!path) {
    return `# Siltpoke: review '${opts.idOrLatest}' not found.\n`;
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

  // `idOrLatest` is an ADDRESS, and "latest" is a sentinel rather than an
  // identity — `/siltpoke-last` runs `siltpoke-cli mark-forwarded` with no
  // argument, so the shipped path always passes it. Recording the sentinel
  // wrote rows that join back to no critique at all (measured on the real
  // store the day the awaited write started landing: `critique_id: "latest"`).
  // Fall back to the address only when the file has no id line to read, which
  // keeps a malformed critique recordable rather than silently unrecorded.
  const resolvedId = (await readCritiqueId(path)) ?? opts.idOrLatest;
  // Awaited on purpose. This used to be fire-and-forget, and this file is
  // also a CLI entry whose process.exit(0) fired before the append reached
  // disk — so a `forward` never landed in preference-log.jsonl. This is the
  // one of the three CLI writers with a real shipped caller: /siltpoke-last
  // runs `siltpoke-cli mark-forwarded` after surfacing a review, so every
  // forward a user has ever produced was dropped here. (mark-forwarded
  // writes no feedback-archive entry, so nothing recorded it elsewhere.)
  // `.catch` keeps the write non-fatal.
  await appendPreferenceEntry(
    {
      critique_id: resolvedId,
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
  return `# Siltpoke: review '${opts.idOrLatest}' marked forwarded${xpNote}.\n`;
}

if (import.meta.main) {
  const idOrLatest = process.argv[2] ?? "latest";
  const basePath = join(process.cwd(), ".siltpoke");
  const out = await markForwarded({ basePath, idOrLatest });
  process.stdout.write(out);
  process.exit(0);
}
