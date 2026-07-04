// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { randomBytes } from "node:crypto";
import type { Span } from "./types";

/**
 * Semantic kind for Siltpoke spans — mirrors Phoenix OpenInference convention.
 * Stored as `siltpoke.kind` attribute on each span so the /traces UI can
 * colour-code and icon the span tree (Step D).
 *
 * Mapping to Phoenix: llm→LLM, tool→TOOL, chain→CHAIN, rubric→EVALUATOR,
 * parser→CHAIN (generic), persist→CHAIN (generic).
 */
export type SpanKind = "llm" | "tool" | "rubric" | "chain" | "parser" | "persist";

/**
 * Clip a JSON-serialised value to at most `maxBytes` UTF-16 code units.
 * Appends a truncation marker when the value is clipped so readers know
 * the output is incomplete.
 */
function jsonClip(value: unknown, maxBytes: number): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  if (s.length <= maxBytes) return s;
  const marker = `\n... [truncated to ${maxBytes} bytes — see spillover for full output]`;
  return s.slice(0, maxBytes - marker.length) + marker;
}

function jsonSerialize(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export class Tracer {
  /**
   * Optional spillover directory. When set + a setInput/setOutput payload
   * exceeds maxBytes, the FULL serialised JSON is fire-and-forget written
   * to `${spilloverDir}/{day}/{trace_id}-{span_id}-{input|output}.json`
   * and the span attribute carries the truncated preview + a
   * `siltpoke.{input|output}.spilled = true` marker.
   *
   * When unset, only the truncated preview is kept in the span attribute.
   */
  private spilloverDir: string | null;

  constructor(opts: { spilloverDir?: string } = {}) {
    this.spilloverDir = opts.spilloverDir ?? null;
  }

  private genTraceId(): string { return randomBytes(16).toString("hex"); }
  private genSpanId(): string { return randomBytes(8).toString("hex"); }

  /**
   * Persist the full payload for a span+role to disk. Fire-and-forget;
   * never throws. Caller has already truncated the in-memory attribute.
   */
  private async writeSpillover(
    span: Span,
    role: "input" | "output",
    fullJson: string,
  ): Promise<void> {
    if (!this.spilloverDir) return;
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const day = new Date(span.start_unix_nano / 1_000_000)
        .toISOString()
        .slice(0, 10);
      const dir = join(this.spilloverDir, day);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${span.trace_id}-${span.span_id}-${role}.json`);
      await writeFile(file, fullJson, "utf8");
    } catch {
      // non-fatal — spillover is best-effort
    }
  }

  startSpan(opts: { name: string; kind: Span["kind"]; parent?: Span; attributes?: Span["attributes"] }): Span {
    return {
      trace_id: opts.parent?.trace_id ?? this.genTraceId(),
      span_id: this.genSpanId(),
      parent_span_id: opts.parent?.span_id ?? null,
      name: opts.name,
      kind: opts.kind,
      start_unix_nano: Date.now() * 1_000_000,
      end_unix_nano: 0,
      status: { code: "UNSET" },
      attributes: { ...(opts.attributes ?? {}) },
      events: [],
    };
  }

  endSpan(span: Span, opts: { status?: "OK" | "ERROR"; message?: string } = {}): void {
    span.end_unix_nano = Date.now() * 1_000_000;
    if (opts.status) span.status = { code: opts.status, message: opts.message };
  }

  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({ time_unix_nano: Date.now() * 1_000_000, name, attributes });
  }

  /**
   * Attach an input payload to the span — serialized as JSON to keep
   * the span store size-bounded. Truncates at 8 KB by default; caller
   * can override via opts.maxBytes.
   */
  setInput(span: Span, input: unknown, opts: { maxBytes?: number } = {}): void {
    const max = opts.maxBytes ?? 8192;
    const full = jsonSerialize(input);
    if (full.length <= max) {
      span.attributes["siltpoke.input"] = full;
      return;
    }
    span.attributes["siltpoke.input"] = jsonClip(input, max);
    span.attributes["siltpoke.input.spilled"] = true;
    span.attributes["siltpoke.input.full_bytes"] = full.length;
    void this.writeSpillover(span, "input", full);
  }

  /**
   * Attach an output payload to the span — serialized as JSON, truncated
   * at 8 KB by default. Full payload spills to disk when over the cap
   * (see writeSpillover) so the trace UI can fetch it on demand.
   */
  setOutput(span: Span, output: unknown, opts: { maxBytes?: number } = {}): void {
    const max = opts.maxBytes ?? 8192;
    const full = jsonSerialize(output);
    if (full.length <= max) {
      span.attributes["siltpoke.output"] = full;
      return;
    }
    span.attributes["siltpoke.output"] = jsonClip(output, max);
    span.attributes["siltpoke.output.spilled"] = true;
    span.attributes["siltpoke.output.full_bytes"] = full.length;
    void this.writeSpillover(span, "output", full);
  }

  /**
   * Tag the span with a Siltpoke semantic kind (llm / tool / rubric /
   * chain / parser / persist) so the UI can colour-code the span tree.
   */
  setKind(span: Span, kind: SpanKind): void {
    span.attributes["siltpoke.kind"] = kind;
  }
}
