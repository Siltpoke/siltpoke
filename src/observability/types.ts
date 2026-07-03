// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
export interface Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: "INTERNAL" | "CLIENT" | "SERVER" | "PRODUCER" | "CONSUMER";
  start_unix_nano: number;
  end_unix_nano: number;
  status: { code: "UNSET" | "OK" | "ERROR"; message?: string };
  attributes: Record<string, string | number | boolean>;
  events: Array<{ time_unix_nano: number; name: string; attributes?: Record<string, unknown> }>;
}
