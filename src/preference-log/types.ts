// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface PreferenceLogEntry {
  ts: string;                                    // ISO timestamp
  critique_id: string;                           // e.g., "c-abc123"
  signal: "ack" | "dismiss" | "forward" | "feedback";
  reason_text: string | null;
  critique_snapshot: Record<string, unknown>;    // full critique at time of signal
  diff_snapshot_sha: string | null;
  intent_at_critique: string | null;
  reflexion_rule_fired: string | null;
}

export type PreferenceLogSignal = PreferenceLogEntry["signal"];
