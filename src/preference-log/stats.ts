// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Aggregate stats over the preference-log used for Block D's
 * "preference history" surface. Cheap O(N) scan; meant to be called
 * once per /history render and shared across all critique cards.
 */
import { readPreferenceLog } from "./reader";

export interface PreferenceStats {
  total: number;
  ack: number;
  dismiss: number;
  forward: number;
  feedback: number;
  /** Per-critique counts so each row can show how often THIS critique was acted on. */
  byCritique: Record<string, { ack: number; dismiss: number; forward: number; feedback: number }>;
  /** ISO timestamps of the oldest + newest entries included. */
  windowStart: string | null;
  windowEnd: string | null;
}

export async function aggregatePreferenceStats(opts: {
  path?: string;
  /** Cutoff in days; default 30. Entries older than now-days are skipped. */
  days?: number;
} = {}): Promise<PreferenceStats> {
  const days = opts.days ?? 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const entries = await readPreferenceLog({ path: opts.path });

  const out: PreferenceStats = {
    total: 0,
    ack: 0,
    dismiss: 0,
    forward: 0,
    feedback: 0,
    byCritique: {},
    windowStart: null,
    windowEnd: null,
  };

  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    out.total++;
    out[e.signal]++;
    const c = (out.byCritique[e.critique_id] ??= { ack: 0, dismiss: 0, forward: 0, feedback: 0 });
    c[e.signal]++;
    if (out.windowStart === null || e.ts < out.windowStart) out.windowStart = e.ts;
    if (out.windowEnd === null || e.ts > out.windowEnd) out.windowEnd = e.ts;
  }

  return out;
}
