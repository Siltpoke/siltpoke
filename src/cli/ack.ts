// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  findCritiqueByIdOrLatest,
  readStatus,
  setStatus,
} from "../state/critique-status";
import { appendPreferenceEntry } from "../preference-log/writer";

function projectSiltpoke(cwd: string): string {
  return join(cwd, ".siltpoke");
}

export interface AckOptions {
  critiqueId: string;
  // Per-project base where critiques live. Defaults to {process.cwd()}/.siltpoke/.
  basePath?: string;
  // Override preference-log path (for test isolation). When unset, the writer's
  // global default (~/.siltpoke/preference-log.jsonl) is used — production keeps
  // the global cross-project stream.
  preferenceLogPath?: string;
}

export interface AckResult {
  status_set: "acked" | "already_acked" | "not_found";
  critique_id: string;
}

export async function runAck(opts: AckOptions): Promise<AckResult> {
  const basePath = opts.basePath ?? projectSiltpoke(process.cwd());
  const path = await findCritiqueByIdOrLatest(basePath, opts.critiqueId);
  if (!path) {
    return { status_set: "not_found", critique_id: opts.critiqueId };
  }
  const previous = await readStatus(path);
  if (previous === "acked") {
    return { status_set: "already_acked", critique_id: opts.critiqueId };
  }
  await setStatus(path, "acked");

  let critiqueSnapshot: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    critiqueSnapshot = { raw_md: raw };
  } catch {
    // best-effort snapshot
  }
  // Awaited on purpose. This used to be fire-and-forget, and this file is
  // also a CLI entry whose process.exit(0) fired before the append reached
  // disk — so an `ack` never landed in preference-log.jsonl at all. (Unlike
  // dismiss, ack writes no feedback-archive entry, so nothing recorded it
  // anywhere else either.) `.catch` keeps the write non-fatal.
  await appendPreferenceEntry(
    {
      critique_id: opts.critiqueId,
      signal: "ack",
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

  return { status_set: "acked", critique_id: opts.critiqueId };
}

if (import.meta.main) {
  const critiqueId = process.argv[2];
  if (!critiqueId) {
    process.stdout.write(
      `${JSON.stringify({ error: "usage: ack <critique_id>" })}\n`,
    );
    process.exit(0);
  }
  const r = await runAck({ critiqueId });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  process.exit(0);
}
