/** @jsxImportSource hono/jsx */
/**
 * SpanTree — split-panel span tree
 */
import { describe, test, expect } from "bun:test";
import { SpanTree, KIND_COLOR } from "../../../src/web/primitives/SpanTree";
import type { SpanNode } from "../../../src/web/primitives/SpanTree";

function makeSpan(overrides: Partial<SpanNode> = {}): SpanNode {
  return {
    trace_id: "trace1".padEnd(32, "0"),
    span_id: "span1".padEnd(16, "0"),
    parent_span_id: null,
    name: "siltpoke.turn",
    start_unix_nano: 1_000_000_000,
    end_unix_nano: 1_050_000_000,
    status: { code: "OK" },
    attributes: { "siltpoke.kind": "chain" },
    ...overrides,
  };
}

describe("SpanTree", () => {
  test("renders empty message when no spans", () => {
    const html = String(<SpanTree spans={[]} activeSpanId="" activeTab="io" />);
    expect(html).toContain("No spans");
  });

  test("renders root span name", () => {
    const span = makeSpan({ name: "siltpoke.turn" });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain("siltpoke.turn");
  });

  test("renders OK status checkmark", () => {
    const span = makeSpan({ status: { code: "OK" } });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain("✓");
  });

  test("renders ERROR status cross", () => {
    const span = makeSpan({ status: { code: "ERROR" } });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain("✗");
  });

  test("renders LLM kind color", () => {
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 200,
      },
    });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain(KIND_COLOR.llm);
  });

  test("renders tool kind color", () => {
    const span = makeSpan({ attributes: { "siltpoke.kind": "tool" } });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain(KIND_COLOR.tool);
  });

  test("renders rubric kind color", () => {
    const span = makeSpan({ attributes: { "siltpoke.kind": "rubric" } });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain(KIND_COLOR.rubric);
  });

  test("click href uses span id in query param", () => {
    const span = makeSpan({ span_id: "abc123deadbeef00" });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain("?span=abc123deadbeef00");
  });

  test("click href includes tab param", () => {
    const span = makeSpan({ span_id: "abc123deadbeef00" });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="messages" />
    );
    // Hono JSX HTML-escapes & in href → &amp;tab=
    expect(html).toContain("amp;tab=messages");
  });

  test("renders child spans with greater depth indentation", () => {
    const root = makeSpan({
      span_id: "root0000000000000",
      name: "root.span",
      parent_span_id: null,
    });
    const child = makeSpan({
      span_id: "child000000000000",
      name: "child.span",
      parent_span_id: "root0000000000000",
    });
    const html = String(
      <SpanTree
        spans={[root, child]}
        activeSpanId={root.span_id}
        activeTab="io"
      />
    );
    expect(html).toContain("root.span");
    expect(html).toContain("child.span");
    // Child should have deeper padding (24px vs 8px)
    expect(html).toContain("24px");
  });

  test("renders duration label", () => {
    const span = makeSpan({
      start_unix_nano: 1_000_000_000,
      end_unix_nano: 1_045_000_000, // 45ms
    });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain("45ms");
  });

  test("renders model label for LLM span", () => {
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.usage.input_tokens": 500,
        "gen_ai.usage.output_tokens": 100,
      },
    });
    const html = String(
      <SpanTree spans={[span]} activeSpanId={span.span_id} activeTab="io" />
    );
    expect(html).toContain("haiku");
  });

  test("active span gets highlighted border", () => {
    const span = makeSpan({
      span_id: "active00000000000",
      attributes: { "siltpoke.kind": "llm" },
    });
    const html = String(
      <SpanTree
        spans={[span]}
        activeSpanId="active00000000000"
        activeTab="io"
      />
    );
    // Active span has solid colored border, inactive has transparent.
    // Task 10b batch 2: KIND_COLOR.llm is now `tokens.color.sky` (=
    // `var(--color-sky)`), not the raw hex — same value, theme-aware.
    expect(html).toContain("3px solid var(--color-sky)"); // KIND_COLOR.llm
  });
});
