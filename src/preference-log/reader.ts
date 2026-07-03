// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PreferenceLogEntry, PreferenceLogSignal } from "./types";

const DEFAULT_PATH = join(homedir(), ".siltpoke", "preference-log.jsonl");

export interface QueryOpts {
  path?: string;
  signal?: PreferenceLogSignal;
  critique_id?: string;
  limit?: number;
}

export async function readPreferenceLog(
  opts: QueryOpts = {},
): Promise<PreferenceLogEntry[]> {
  const path = opts.path ?? DEFAULT_PATH;
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const entries: PreferenceLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as PreferenceLogEntry;
      if (opts.signal && e.signal !== opts.signal) continue;
      if (opts.critique_id && e.critique_id !== opts.critique_id) continue;
      entries.push(e);
    } catch {
      // skip malformed lines
    }
  }
  if (opts.limit) return entries.slice(-opts.limit);
  return entries;
}

export async function countBySignal(
  opts: { path?: string } = {},
): Promise<Record<PreferenceLogSignal, number>> {
  const entries = await readPreferenceLog(opts);
  const counts: Record<PreferenceLogSignal, number> = {
    ack: 0,
    dismiss: 0,
    forward: 0,
    feedback: 0,
  };
  for (const e of entries) counts[e.signal]++;
  return counts;
}
