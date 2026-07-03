// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
export type Embedding = Float32Array;

export interface FewShotIndexEntry {
  id: string;                       // critique_id
  embedding: number[];              // serialized as JSON-friendly array
  signal: "dismiss";                // only dismissed; ack/forward = positive examples, not anti
  reason_text: string | null;
  critique_summary: string;         // short text used as anti-example body
  ts: string;
}
