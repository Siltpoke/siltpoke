// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { test, expect } from "bun:test";
import { parseReflectionOutput } from "../../src/brain/reflection-schema";

const base = {
  reflection: "I was wrong about null handling.",
  learned_rule: "Before flagging NULL handling, grep for existing checks.",
  rule_category: "null_check",
  confidence: "high" as const,
  applies_to_file_types: ["py"],
};

test("parseReflectionOutput accepts a learned_rule at the 200-char cap", () => {
  const out = parseReflectionOutput({
    ...base,
    learned_rule: "x".repeat(200),
  });
  expect(out.learned_rule).toHaveLength(200);
});

// [hardening] Control 2 (2026-07-13): a legitimate learned_rule is ONE
// imperative sentence (the reflection system prompt already says so at
// src/brain/reflection.ts:30) — a rule far past that length is either a
// hallucination or an attempt to smuggle a large instruction block into the
// highest-trust position of every future critic system prompt.
test("[hardening] parseReflectionOutput rejects a learned_rule over 200 chars", () => {
  expect(() =>
    parseReflectionOutput({
      ...base,
      learned_rule: "x".repeat(201),
    }),
  ).toThrow();
});
