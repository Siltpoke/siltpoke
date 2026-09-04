// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * TraceWaterfall — call-site token-emission tests.
 *
 * Task 10b batch 2, review round 1 finding: there was no test file for this
 * primitive at all, so nothing asserted `KIND_COLORS`/`TRACK_BG`/
 * `DEFAULT_BAR_COLOR` actually emit `var(--kind-*)`/`var(--color-*)` rather
 * than a raw hex — the same call-site-emission check `SpanTree.test.tsx`
 * ("active span gets highlighted border") and `staleness-badge.test.ts`
 * ("fresh is green, drifting is amber/yellow...") already carry for their
 * own files. `KIND_COLORS`/`DEFAULT_BAR_COLOR`/`TRACK_BG` are module-private
 * (not exported), so these tests read the rendered HTML string, matching
 * `SpanTree.test.tsx`'s own `String(<Component .../>)` pattern.
 */
import { describe, test, expect } from "bun:test";
import { TraceWaterfall } from "../../../src/web/primitives/TraceWaterfall";
import type { WaterfallSpan } from "../../../src/web/primitives/TraceWaterfall";

function makeSpan(overrides: Partial<WaterfallSpan> = {}): WaterfallSpan {
  return {
    trace_id: "trace1".padEnd(32, "0"),
    span_id: "span1".padEnd(16, "0"),
    parent_span_id: null,
    name: "siltpoke.turn",
    start_unix_nano: 1_000_000_000,
    end_unix_nano: 1_050_000_000,
    status: { code: "OK" },
    ...overrides,
  };
}

describe("TraceWaterfall", () => {
  test("renders empty message when no spans", () => {
    const html = String(<TraceWaterfall spans={[]} />);
    expect(html).toContain("No spans");
  });

  test("a mapped kind name emits its var(--kind-*) token, not a raw hex", () => {
    const span = makeSpan({ name: "siltpoke.turn" });
    const html = String(<TraceWaterfall spans={[span]} />);
    expect(html).toContain("var(--kind-turn)");
    expect(html).not.toContain("#9c1c1c");
  });

  test("every KIND_COLORS-mapped kind name emits its own var(--kind-*) token", () => {
    const names: Array<[string, string]> = [
      ["siltpoke.turn", "var(--kind-turn)"],
      ["siltpoke.summarizer.haiku", "var(--kind-summarizerHaiku)"],
      ["siltpoke.rubric.tier1", "var(--kind-rubricTier1)"],
      ["siltpoke.rubric.tier2", "var(--kind-rubricTier2)"],
      ["siltpoke.intent.classify", "var(--kind-intentClassify)"],
      ["siltpoke.prompt.build", "var(--kind-promptBuild)"],
      ["siltpoke.brain.find", "var(--kind-brainFind)"],
      ["siltpoke.response.parse", "var(--kind-responseParse)"],
      ["siltpoke.critique.persist", "var(--kind-critiquePersist)"],
    ];
    for (const [name, token] of names) {
      const html = String(<TraceWaterfall spans={[makeSpan({ name })]} />);
      expect(html, `${name} should render ${token}`).toContain(token);
    }
  });

  test("siltpoke.brain.verify shares summarizerHaiku's token (pre-existing one-literal-two-keys design, not a separate token)", () => {
    const html = String(<TraceWaterfall spans={[makeSpan({ name: "siltpoke.brain.verify" })]} />);
    expect(html).toContain("var(--kind-summarizerHaiku)");
  });

  test("an unmapped span name falls back to var(--color-ink), not a raw hex", () => {
    const span = makeSpan({ name: "some.unrecognized.kind" });
    const html = String(<TraceWaterfall spans={[span]} />);
    expect(html).toContain("var(--color-ink)");
    expect(html).not.toContain("#2a241c");
  });

  test("the bar track background is var(--color-edge), not a raw hex", () => {
    const span = makeSpan();
    const html = String(<TraceWaterfall spans={[span]} />);
    expect(html).toContain("var(--color-edge)");
    expect(html).not.toContain("#d8cbab");
  });
});
