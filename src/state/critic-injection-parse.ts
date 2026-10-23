// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * critic-event-log — the injection-alert and tool-call fields of a
 * `brain-calls.jsonl` row. Split out of critic-event-log-parse.ts (file cap).
 *
 * Both fields are read tolerantly: a row is never rejected because of them.
 * A hand-edited or future-build value that fails the shape check reads as
 * `null` (= "no claim"), never as a made-up alert.
 */

import type { ToolCallRecord, ToolCallsField } from "../brain/tool-calls";
import type { InjectionAlert, InjectionSignal } from "../critic/injection-alert";

interface RawInjectionFields {
  injection_alert?: unknown;
  tool_calls?: unknown;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const KINDS: ReadonlySet<unknown> = new Set(["self", "tool", "echo", "scan"]);
const LEVELS: ReadonlySet<unknown> = new Set(["loud", "quiet"]);

function signalOf(v: unknown): InjectionSignal | null {
  const o = obj(v);
  if (o === null) return null;
  if (!KINDS.has(o.kind) || !LEVELS.has(o.level)) return null;
  if (typeof o.where !== "string" || typeof o.quote !== "string" || typeof o.why !== "string") return null;
  return { kind: o.kind as InjectionSignal["kind"], level: o.level as InjectionSignal["level"], where: o.where, quote: o.quote, why: o.why };
}

/**
 * The row's injection alert, or `null`. Invalid `level` / non-array `signals` →
 * `null`; individual malformed signals are dropped; none left → `null`. A
 * missing or invalid `toolRecord` reads as `"not_recorded"` — the safe side:
 * it never claims the reviewer's tool use was observed.
 */
export function injectionAlertOf(raw: RawInjectionFields): InjectionAlert | null {
  const o = obj(raw.injection_alert);
  if (o === null || !LEVELS.has(o.level) || !Array.isArray(o.signals)) return null;
  const signals = o.signals.map(signalOf).filter((s): s is InjectionSignal => s !== null);
  if (signals.length === 0) return null;
  return {
    level: o.level as InjectionAlert["level"],
    signals,
    toolRecord: o.toolRecord === "recorded" ? "recorded" : "not_recorded",
  };
}

function recordOf(v: unknown): ToolCallRecord | null {
  const o = obj(v);
  if (o === null || typeof o.tool !== "string" || typeof o.target !== "string" || typeof o.failed !== "boolean") return null;
  return { tool: o.tool, target: o.target, failed: o.failed };
}

/** The reviewer's tool calls, `"not_recorded"`, or `null` on rows written before #1090 (or malformed). */
export function toolCallsOf(raw: RawInjectionFields): ToolCallsField | null {
  const v = raw.tool_calls;
  if (v === "not_recorded") return v;
  if (!Array.isArray(v)) return null;
  const recs = v.map(recordOf);
  return recs.every((r): r is ToolCallRecord => r !== null) ? (recs as ToolCallRecord[]) : null;
}
