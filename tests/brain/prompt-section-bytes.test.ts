// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-section byte counts for the assembled critic prompt.
 *
 * The prompt has grown, and until now only ONE of its sections was measured:
 * `rules_bytes_in_prompt`, the learned-rules listing. Everything else — tool
 * output, caller impact, reverse deps, anti-examples, the memory block, the
 * recent block — went into the same string with nothing recording how much of
 * it each contributed.
 *
 * That gap is why a real regression could only be described and not located.
 * Measured across `~/.siltpoke/brain-calls.jsonl`: the non-cached part of the
 * prompt went from a 12.8k-token median on 2026-08-02 to 39.9k on 2026-08-08,
 * while `cache_read` stayed flat at ~15.2k and `rules_bytes_in_prompt` never
 * exceeded 385 bytes. Over the same span the critic call's median duration
 * went 39.5s → 79.4s and its rate of hitting the 90s kill timer went 8% → 41%
 * (span durations from `~/.siltpoke/traces/`, n=3809). So something in the
 * bundle tripled, the one instrumented component was not it, and there was no
 * way to say which of the other six it was.
 *
 * These counts are taken on the RENDERED block, at the point it is actually
 * pushed — the same discipline `rules_bytes_in_prompt` already follows, so a
 * section that is built and then dropped reads zero rather than inheriting a
 * size it never contributed.
 */
import { describe, expect, test } from "bun:test";
import { assembleSystemPromptWithFunnel } from "../../src/brain/prompt-assembly";
import type { CoreMemory } from "../../src/memory/memory";

function emptyMemory(): CoreMemory {
  return {
    schema_version: 3,
    long_term_summary: "",
    learned_rules: [],
    facts: [],
    recent_feedback: [],
  } as unknown as CoreMemory;
}

function assemble(over: Record<string, unknown> = {}) {
  return assembleSystemPromptWithFunnel({
    personalitySystemPrompt: "BASE PROMPT",
    memory: null,
    recent: [],
    nonce: "test-nonce",
    ...over,
  } as never);
}

describe("prompt section bytes", () => {
  test("a section that was never pushed reads zero, not undefined", () => {
    const { sizes } = assemble();
    expect(sizes.tool_output).toBe(0);
    expect(sizes.caller_impact).toBe(0);
    expect(sizes.reverse_deps).toBe(0);
    expect(sizes.anti_examples).toBe(0);
    expect(sizes.memory).toBe(0);
    expect(sizes.recent).toBe(0);
  });

  test("the total is the assembled prompt's own byte length — not a sum of parts", () => {
    // Summing the sections would silently omit the framing paragraph and the
    // newlines between blocks, so a growing prompt could show flat sections
    // and nobody would see the growth. The total is measured on the string.
    const { prompt, sizes } = assemble({ toolOutputSection: "x".repeat(500) });
    expect(sizes.total).toBe(Buffer.byteLength(prompt, "utf8"));
    const parts = sizes.base + sizes.memory + sizes.recent + sizes.tool_output +
      sizes.caller_impact + sizes.reverse_deps + sizes.anti_examples;
    expect(parts).toBeLessThan(sizes.total);
  });

  test("tool output is attributed to tool output, and does not leak into the other sections", () => {
    // The regression this exists to locate: one section tripling while the
    // others hold. An implementation that measured the whole prompt per
    // section, or attributed everything to the last block pushed, would pass a
    // "total grew" assertion and still be useless.
    const small = assemble({ toolOutputSection: "y".repeat(100) }).sizes;
    const large = assemble({ toolOutputSection: "y".repeat(100_000) }).sizes;
    expect(large.tool_output - small.tool_output).toBeGreaterThanOrEqual(99_900);
    expect(large.caller_impact).toBe(small.caller_impact);
    expect(large.anti_examples).toBe(small.anti_examples);
    expect(large.memory).toBe(small.memory);
    expect(large.base).toBe(small.base);
  });

  test("each of the four fenced sections lands in its own field", () => {
    const { sizes } = assemble({
      toolOutputSection: "t".repeat(1000),
      callerImpactSection: "c".repeat(2000),
      reverseDepsSection: "r".repeat(3000),
      antiExamplesBlock: "a".repeat(4000),
    });
    // Fencing adds a wrapper, so each is at least its payload — and each is
    // strictly ordered by payload size, which no single-bucket implementation
    // could produce.
    expect(sizes.tool_output).toBeGreaterThanOrEqual(1000);
    expect(sizes.caller_impact).toBeGreaterThan(sizes.tool_output);
    expect(sizes.reverse_deps).toBeGreaterThan(sizes.caller_impact);
    expect(sizes.anti_examples).toBeGreaterThan(sizes.reverse_deps);
  });

  test("the memory block's bytes are the WHOLE block, of which the rules listing is a part", () => {
    // `rules_bytes_in_prompt` measures only the rules listing. It stays exactly
    // as it was — this adds a wider measurement beside it rather than
    // redefining a number other tooling already reads.
    //
    // The fixture carries a REAL rule, and that is the point. A review found
    // this test with an empty `learned_rules`, which made `rulesListing` render
    // to "" and `rules_bytes_in_prompt` read 0 — and then an implementation
    // measuring only `long_term_summary`, silently dropping the rules listing
    // and style facts out of `sizes.memory`, passed it unmodified. The test
    // named the whole block and proved only a part of it.
    const RULE_BODY = "never trust a size you did not render";
    const memory = {
      ...emptyMemory(),
      long_term_summary: "s".repeat(5000),
      learned_rules: [
        { id: "r-1", category: "misc", rule: RULE_BODY, status: "active", file_types: undefined },
      ],
    } as unknown as CoreMemory;
    const { sizes, funnel } = assemble({ memory });
    expect(funnel.rules_bytes_in_prompt).toBeGreaterThan(0);
    // Strictly larger than the summary AND the listing together — the block
    // also carries the framing sentences and the LEARNED_RULES fence, so
    // measuring either component alone lands below this.
    expect(sizes.memory).toBeGreaterThan(5000 + funnel.rules_bytes_in_prompt);
    // ...and the rule text really is inside the block being measured, so a
    // `sizes.memory` computed off `long_term_summary` alone cannot satisfy it.
    const { prompt } = assemble({ memory });
    expect(prompt).toContain(RULE_BODY);
  });

  test("the base prompt is measured too — it is not free", () => {
    const small = assemble({ personalitySystemPrompt: "b".repeat(10) }).sizes;
    const large = assemble({ personalitySystemPrompt: "b".repeat(10_000) }).sizes;
    expect(large.base - small.base).toBe(9_990);
  });

  test("sizes are BYTES, not characters — one CJK character is three", () => {
    // Every assertion above uses ASCII, where byte length and code-unit length
    // agree, so none of them can tell `Buffer.byteLength(s, "utf8")` apart from
    // `s.length`. This corpus is Chinese in practice; a character-count
    // implementation would under-report the prompt by ~3x exactly where the
    // measurement is supposed to be raising an alarm.
    const ascii = assemble({ personalitySystemPrompt: "x".repeat(300) }).sizes;
    const cjk = assemble({ personalitySystemPrompt: "字".repeat(300) }).sizes;
    expect(ascii.base).toBe(300);
    expect(cjk.base).toBe(900);
  });
});
