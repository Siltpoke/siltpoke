// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * setBrainUsageAttrs — track #7 T3 (AC14): span truth per provider.
 */
import { test, expect } from "bun:test";
import { Tracer } from "../../../src/observability/tracer";
import { setBrainUsageAttrs } from "../../../src/critic/phases/usage-attrs";
import type { BrainUsage } from "../../../src/brain/brain";

const usage: BrainUsage = {
  cache_creation_input_tokens: 1,
  cache_read_input_tokens: 2,
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.001,
};

test("defaults gen_ai.system to anthropic when no provider arg is passed (existing call sites unaffected)", () => {
  const tracer = new Tracer();
  const span = tracer.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT" });
  setBrainUsageAttrs(tracer, span, usage, "claude-haiku-4-5");
  expect(span.attributes["gen_ai.system"]).toBe("anthropic");
  expect(span.attributes["gen_ai.request.model"]).toBe("claude-haiku-4-5");
  expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(100);
});

test("codex provider — gen_ai.system reflects openai, model reflects servedModel", () => {
  const tracer = new Tracer();
  const span = tracer.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT" });
  setBrainUsageAttrs(tracer, span, usage, "gpt-5-codex", "openai");
  expect(span.attributes["gen_ai.system"]).toBe("openai");
  expect(span.attributes["gen_ai.request.model"]).toBe("gpt-5-codex");
});

test("usage fields always set even when usage is nullish-shaped", () => {
  const tracer = new Tracer();
  const span = tracer.startSpan({ name: "siltpoke.brain.find", kind: "CLIENT" });
  setBrainUsageAttrs(
    tracer,
    span,
    // biome-ignore lint: exercising the `usage ?? {}` guard
    undefined as unknown as BrainUsage,
    "gpt-5-codex",
    "openai",
  );
  expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(0);
  expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(0);
});
