import { describe, test, expect, beforeEach } from "bun:test";
import { Tracer } from "../../src/observability/tracer";

describe("Tracer", () => {
  let tracer: Tracer;
  beforeEach(() => { tracer = new Tracer(); });

  test("startSpan returns span with stable IDs", () => {
    const root = tracer.startSpan({ name: "root", kind: "INTERNAL" });
    expect(root.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(root.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(root.parent_span_id).toBeNull();
  });

  test("child span inherits trace_id, parent_span_id = parent.span_id", () => {
    const root = tracer.startSpan({ name: "root", kind: "INTERNAL" });
    const child = tracer.startSpan({ name: "child", kind: "INTERNAL", parent: root });
    expect(child.trace_id).toBe(root.trace_id);
    expect(child.parent_span_id).toBe(root.span_id);
  });

  test("endSpan sets end_unix_nano + status", () => {
    const span = tracer.startSpan({ name: "s", kind: "INTERNAL" });
    tracer.endSpan(span, { status: "OK" });
    expect(span.end_unix_nano).toBeGreaterThanOrEqual(span.start_unix_nano);
    expect(span.status.code).toBe("OK");
  });

  test("setAttribute mutates attributes", () => {
    const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
    tracer.setAttribute(s, "gen_ai.system", "anthropic");
    tracer.setAttribute(s, "gen_ai.usage.input_tokens", 1234);
    expect(s.attributes["gen_ai.system"]).toBe("anthropic");
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(1234);
  });

  // setInput / setOutput / setKind
  describe("setInput", () => {
    test("stores JSON-serialised value in siltpoke.input", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      tracer.setInput(s, { messages: [{ role: "user", content: "hello" }] });
      const val = s.attributes["siltpoke.input"];
      expect(typeof val).toBe("string");
      expect((val as string)).toContain("user");
    });

    test("stores plain string value as-is", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      tracer.setInput(s, "raw prompt text");
      expect(s.attributes["siltpoke.input"]).toBe("raw prompt text");
    });

    test("truncates at 8192 chars by default and appends truncation marker", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      const long = "x".repeat(10_000);
      tracer.setInput(s, long);
      const val = s.attributes["siltpoke.input"] as string;
      expect(val.length).toBeLessThanOrEqual(8192);
      expect(val).toMatch(/\[truncated to 8192 bytes/);
    });

    test("respects custom maxBytes override", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      const long = "a".repeat(500);
      tracer.setInput(s, long, { maxBytes: 100 });
      const val = s.attributes["siltpoke.input"] as string;
      expect(val.length).toBeLessThanOrEqual(100);
      expect(val).toMatch(/\[truncated to 100 bytes/);
    });

    test("does not truncate values within the limit", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      const short = "hello";
      tracer.setInput(s, short);
      expect(s.attributes["siltpoke.input"]).toBe("hello");
    });
  });

  describe("setOutput", () => {
    test("stores JSON-serialised output in siltpoke.output", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      tracer.setOutput(s, { mood: "happy", severity: "info" });
      const val = s.attributes["siltpoke.output"] as string;
      expect(val).toContain("mood");
      expect(val).toContain("happy");
    });

    test("truncates large output at 8192 chars", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      const big = { data: "z".repeat(9000) };
      tracer.setOutput(s, big);
      const val = s.attributes["siltpoke.output"] as string;
      expect(val.length).toBeLessThanOrEqual(8192);
      expect(val).toMatch(/\[truncated to 8192 bytes/);
    });
  });

  describe("setKind", () => {
    test("stores kind in siltpoke.kind attribute", () => {
      const s = tracer.startSpan({ name: "s", kind: "INTERNAL" });
      tracer.setKind(s, "llm");
      expect(s.attributes["siltpoke.kind"]).toBe("llm");
    });

    test("all SpanKind values are accepted", () => {
      const kinds = ["llm", "tool", "rubric", "chain", "parser", "persist"] as const;
      for (const k of kinds) {
        const s = tracer.startSpan({ name: k, kind: "INTERNAL" });
        tracer.setKind(s, k);
        expect(s.attributes["siltpoke.kind"]).toBe(k);
      }
    });
  });
});
