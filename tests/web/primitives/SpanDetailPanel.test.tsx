/** @jsxImportSource hono/jsx */
/**
 * SpanDetailPanel — 4-tab detail panel
 */
import { describe, test, expect } from "bun:test";
import { SpanDetailPanel } from "../../../src/web/primitives/SpanDetailPanel";
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

describe("SpanDetailPanel", () => {
  test("renders span name in header", () => {
    const span = makeSpan({ name: "siltpoke.brain.find" });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="io"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("siltpoke.brain.find");
  });

  test("renders tab bar with all 5 tabs", () => {
    const span = makeSpan();
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="io"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("Messages");
    expect(html).toContain("I/O");
    expect(html).toContain("Tools");
    expect(html).toContain("Metadata");
    expect(html).toContain("Raw");
  });

  test("I/O tab shows input/output sections", () => {
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "siltpoke.input": JSON.stringify({ query: "hello" }),
        "siltpoke.output": JSON.stringify({ result: "world" }),
      },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="io"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("Input");
    expect(html).toContain("Output");
  });

  test("I/O tab shows empty state message when no input", () => {
    const span = makeSpan({ attributes: { "siltpoke.kind": "chain" } });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="io"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("pre-dates");
  });

  test("Messages tab only available for LLM spans (disabled for chain)", () => {
    const span = makeSpan({ attributes: { "siltpoke.kind": "chain" } });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="messages"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("only available for LLM spans");
  });

  test("Messages tab shows messages for LLM span with valid input", () => {
    const input = JSON.stringify({
      system: "You are helpful.",
      messages: [{ role: "user", content: "hello" }],
    });
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "siltpoke.input": input,
        "siltpoke.output": JSON.stringify("World reply"),
      },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="messages"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("system");
    expect(html).toContain("user");
  });

  test("Tools tab shows empty state when no tool children", () => {
    const span = makeSpan({ attributes: { "siltpoke.kind": "llm" } });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="tools"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("No tool child spans");
  });

  test("Tools tab shows tool children", () => {
    const parent = makeSpan({
      span_id: "parent0000000000",
      attributes: { "siltpoke.kind": "llm" },
    });
    const toolChild = makeSpan({
      span_id: "child00000000000",
      parent_span_id: "parent0000000000",
      name: "siltpoke.tool.tsc",
      attributes: {
        "siltpoke.kind": "tool",
        "siltpoke.tool.name": "tsc",
        "siltpoke.tool.args": '{"cmd":"tsc --noEmit"}',
        "siltpoke.tool.result": "no errors",
      },
    });
    const html = String(
      <SpanDetailPanel
        span={parent}
        allSpans={[parent, toolChild]}
        activeTab="tools"
        activeSpanId={parent.span_id}
      />
    );
    expect(html).toContain("tsc");
  });

  test("Metadata tab shows span attributes", () => {
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.usage.input_tokens": 500,
      },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="metadata"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("gen_ai.request.model");
    expect(html).toContain("claude-haiku-4-5");
  });

  test("Metadata tab excludes siltpoke.input and siltpoke.output", () => {
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "siltpoke.input": '{"secret": "data"}',
        "siltpoke.output": '{"result": "answer"}',
      },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="metadata"
        activeSpanId={span.span_id}
      />
    );
    // Key names should not appear in metadata table
    expect(html).not.toContain("siltpoke.input");
    expect(html).not.toContain("siltpoke.output");
  });

  test("Raw tab renders full span JSON with syntax coloring and no outer toggle", () => {
    const span = makeSpan({ name: "raw-test-span" });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="raw"
        activeSpanId={span.span_id}
      />
    );
    // Raw tab uses JsonView mode="expanded" — no outer expand/collapse toggle text.
    // Inner JsonNode <details> for nested objects are acceptable (colored rendering).
    expect(html).not.toContain("expand");
    expect(html).not.toContain("collapse");
    // Span name appears in the colored JSON dump.
    expect(html).toContain("raw-test-span");
    // Syntax color spans present (sky color for keys)
    expect(html).toContain("color:#7fb0c8");
  });

  test("tab links include span id and tab in href for enabled tabs", () => {
    // Use an LLM span so Messages tab is also a link
    const span = makeSpan({
      span_id: "testspan00000000",
      attributes: { "siltpoke.kind": "llm" },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="io"
        activeSpanId={span.span_id}
      />
    );
    // Hono JSX HTML-escapes & in href → &amp;tab= in rendered output
    expect(html).toContain("?span=testspan00000000&amp;tab=messages");
    expect(html).toContain("?span=testspan00000000&amp;tab=metadata");
  });

  test("ERROR status shown in header", () => {
    const span = makeSpan({
      status: { code: "ERROR", message: "tool failed" },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="metadata"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("✗ ERROR");
  });

  test("LLM token counts visible in header", () => {
    const span = makeSpan({
      attributes: {
        "siltpoke.kind": "llm",
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 350,
      },
    });
    const html = String(
      <SpanDetailPanel
        span={span}
        allSpans={[span]}
        activeTab="io"
        activeSpanId={span.span_id}
      />
    );
    expect(html).toContain("1.2k");
    expect(html).toContain("350");
  });
});
