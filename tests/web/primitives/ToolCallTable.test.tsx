/** @jsxImportSource hono/jsx */
/**
 * ToolCallTable — tool spans table
 */
import { describe, test, expect } from "bun:test";
import { ToolCallTable } from "../../../src/web/primitives/ToolCallTable";
import type { SpanNode } from "../../../src/web/primitives/SpanTree";

function makeToolSpan(overrides: Partial<SpanNode> = {}): SpanNode {
  return {
    trace_id: "trace1".padEnd(32, "0"),
    span_id: "tool".padEnd(16, "0"),
    parent_span_id: "parent0000000000",
    name: "siltpoke.tool.tsc",
    start_unix_nano: 1_000_000_000,
    end_unix_nano: 1_012_000_000,
    status: { code: "OK" },
    attributes: {
      "siltpoke.kind": "tool",
      "siltpoke.tool.name": "tsc",
      "siltpoke.tool.args": '{"cmd": "tsc --noEmit"}',
      "siltpoke.tool.result": "no errors found",
    },
    ...overrides,
  };
}

describe("ToolCallTable", () => {
  test("renders empty state when no tool spans", () => {
    const html = String(<ToolCallTable toolSpans={[]} />);
    expect(html).toContain("No tool child spans");
  });

  test("renders tool name column", () => {
    const span = makeToolSpan();
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("tsc");
  });

  test("renders status OK", () => {
    const span = makeToolSpan({ status: { code: "OK" } });
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("✓ ok");
  });

  test("renders status ERROR", () => {
    const span = makeToolSpan({ status: { code: "ERROR" } });
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("✗ error");
  });

  test("renders duration", () => {
    const span = makeToolSpan({
      start_unix_nano: 1_000_000_000,
      end_unix_nano: 1_042_000_000, // 42ms
    });
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("42ms");
  });

  test("renders args preview", () => {
    const span = makeToolSpan({
      attributes: {
        "siltpoke.kind": "tool",
        "siltpoke.tool.name": "git-diff",
        "siltpoke.tool.args": '{"rev": "HEAD~1"}',
        "siltpoke.tool.result": "diff output here",
      },
    });
    const html = String(<ToolCallTable toolSpans={[span]} />);
    // JSON is HTML-escaped in rendered output
    expect(html).toContain("HEAD~1");
  });

  test("renders result preview", () => {
    const span = makeToolSpan();
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("no errors found");
  });

  test("renders multiple tool spans as rows", () => {
    const tsc = makeToolSpan({ span_id: "tsc0000000000000", name: "siltpoke.tool.tsc" });
    const eslint = makeToolSpan({
      span_id: "eslint000000000",
      name: "siltpoke.tool.eslint",
      attributes: {
        "siltpoke.kind": "tool",
        "siltpoke.tool.name": "eslint",
        "siltpoke.tool.args": "",
        "siltpoke.tool.result": "0 warnings",
      },
    });
    const html = String(<ToolCallTable toolSpans={[tsc, eslint]} />);
    expect(html).toContain("tsc");
    expect(html).toContain("eslint");
    expect(html).toContain("0 warnings");
  });

  test("shows dash for missing args", () => {
    const span = makeToolSpan({
      attributes: {
        "siltpoke.kind": "tool",
        "siltpoke.tool.name": "ripgrep",
        "siltpoke.tool.args": "",
        "siltpoke.tool.result": "matches found",
      },
    });
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("—");
  });

  test("renders expandable details for args", () => {
    const span = makeToolSpan();
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
  });

  test("renders table headers", () => {
    const span = makeToolSpan();
    const html = String(<ToolCallTable toolSpans={[span]} />);
    expect(html).toContain("Tool");
    expect(html).toContain("Status");
    expect(html).toContain("Duration");
    expect(html).toContain("Args");
    expect(html).toContain("Result");
  });
});
