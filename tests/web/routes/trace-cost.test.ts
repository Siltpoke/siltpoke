// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * buildBrainCosts — track #7 T3 (AC8/AC14): a non-anthropic span (codex,
 * quota-billed) must never be priced against the claude rate table.
 */
import { test, expect } from "bun:test";
import { buildBrainCosts } from "../../../src/web/routes/trace-cost";
import type { Span } from "../../../src/observability/types";

function makeSpan(attrs: Record<string, string | number | boolean>): Span {
  return {
    trace_id: "t1",
    span_id: "s1",
    parent_span_id: null,
    name: "siltpoke.brain.find",
    kind: "CLIENT",
    start_unix_nano: 0,
    end_unix_nano: 100 * 1_000_000,
    status: { code: "OK" },
    attributes: attrs,
    events: [],
  };
}

test("anthropic span is priced normally (unchanged behavior)", () => {
  const [cost] = buildBrainCosts([
    makeSpan({
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 500,
      "gen_ai.usage.cache_read_input_tokens": 0,
    }),
  ]);
  expect(cost!.cost_usd).toBeGreaterThan(0);
  expect(cost!.model).toBe("claude-haiku-4-5");
});

test("codex (openai) span never priced — cost_usd 0, no haiku fallback", () => {
  const [cost] = buildBrainCosts([
    makeSpan({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-5-codex",
      "gen_ai.usage.input_tokens": 100000,
      "gen_ai.usage.output_tokens": 50000,
      "gen_ai.usage.cache_read_input_tokens": 0,
    }),
  ]);
  expect(cost!.cost_usd).toBe(0);
  expect(cost!.cache_savings_usd).toBe(0);
  expect(cost!.model).toBe("gpt-5-codex");
});

test("codex span with no request.model attr labels as (unknown), not claude-haiku-4-5", () => {
  const [cost] = buildBrainCosts([
    makeSpan({
      "gen_ai.system": "openai",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
    }),
  ]);
  expect(cost!.model).toBe("(unknown)");
  expect(cost!.cost_usd).toBe(0);
});

test("legacy span with no gen_ai.system attr at all defaults to anthropic pricing (pre-track behavior preserved)", () => {
  const [cost] = buildBrainCosts([
    makeSpan({
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 1000,
      "gen_ai.usage.output_tokens": 500,
    }),
  ]);
  expect(cost!.cost_usd).toBeGreaterThan(0);
});
