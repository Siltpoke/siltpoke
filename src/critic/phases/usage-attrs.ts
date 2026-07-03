// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Thread a Brain call's usage block onto its OTEL span as `gen_ai.*`
 * attributes — the trace cost table (buildBrainCosts in
 * src/web/routes/trace-cost.ts) reads exactly these keys to compute
 * per-span cost/savings. Without them every live brain span renders
 * $0.00 / 0 tok while the real spend sits only in usage-events.jsonl.
 */
import type { BrainUsage } from "../../brain/brain";
import type { Tracer } from "../../observability/tracer";
import type { Span } from "../../observability/types";

export function setBrainUsageAttrs(
  tracer: Tracer,
  span: Span,
  usage: BrainUsage,
  model: string,
): void {
  // usage originates in external subprocess JSON; both call sites sit inside
  // the phases' Brain-call try blocks, where a throw would mislabel an
  // already-successful call as "Brain call failed" → HARD_SUPPRESS. Guard the
  // whole object, not just the fields.
  const u: Partial<BrainUsage> = usage ?? {};
  tracer.setAttribute(span, "gen_ai.request.model", model);
  tracer.setAttribute(span, "gen_ai.usage.input_tokens", u.input_tokens ?? 0);
  tracer.setAttribute(span, "gen_ai.usage.output_tokens", u.output_tokens ?? 0);
  tracer.setAttribute(span, "gen_ai.usage.cache_read_input_tokens", u.cache_read_input_tokens ?? 0);
  tracer.setAttribute(span, "gen_ai.usage.cache_creation_input_tokens", u.cache_creation_input_tokens ?? 0);
}
