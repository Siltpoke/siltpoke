// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PreferenceLogEntry } from "./types";

const DEFAULT_PATH = join(homedir(), ".siltpoke", "preference-log.jsonl");

export interface AppendOpts {
  path?: string;
}

export async function appendPreferenceEntry(
  entry: Omit<PreferenceLogEntry, "ts"> & { ts?: string },
  opts: AppendOpts = {},
): Promise<void> {
  const path = opts.path ?? DEFAULT_PATH;
  const fullEntry: PreferenceLogEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    critique_id: entry.critique_id,
    signal: entry.signal,
    reason_text: entry.reason_text ?? null,
    critique_snapshot: entry.critique_snapshot,
    diff_snapshot_sha: entry.diff_snapshot_sha ?? null,
    intent_at_critique: entry.intent_at_critique ?? null,
    reflexion_rule_fired: entry.reflexion_rule_fired ?? null,
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(fullEntry)}\n`);
}
