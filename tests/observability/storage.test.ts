import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../../src/observability/storage";
import type { Span } from "../../src/observability/types";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `siltpoke-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    trace_id: "aaaa".repeat(8),
    span_id: "bbbb".repeat(4),
    parent_span_id: null,
    name: "test.span",
    kind: "INTERNAL",
    start_unix_nano: Date.now() * 1_000_000,
    end_unix_nano: (Date.now() + 10) * 1_000_000,
    status: { code: "OK" },
    attributes: {},
    events: [],
    ...overrides,
  };
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  dirs.length = 0;
});

describe("TraceStore", () => {
  test("writeSpan appends to JSONL and indexes SQLite", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = new TraceStore({ dir, dbPath: join(dir, "index.sqlite") });
    const span = makeSpan({ trace_id: "cafe".repeat(8), span_id: "dead".repeat(4) });
    await store.writeSpan(span);

    const spans = store.getSpansByTrace(span.trace_id);
    expect(spans).toHaveLength(1);
    expect(spans[0].span_id).toBe(span.span_id);
  });

  test("getSpansByTrace returns all spans for trace_id", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = new TraceStore({ dir, dbPath: join(dir, "index.sqlite") });
    const traceId = "1234".repeat(8);

    await store.writeSpan(makeSpan({ trace_id: traceId, span_id: "aaaa".repeat(4), name: "root" }));
    await store.writeSpan(makeSpan({ trace_id: traceId, span_id: "bbbb".repeat(4), name: "child" }));
    // Different trace — should not appear
    await store.writeSpan(makeSpan({ trace_id: "9999".repeat(8), span_id: "cccc".repeat(4) }));

    const spans = store.getSpansByTrace(traceId);
    expect(spans).toHaveLength(2);
    expect(spans.map(s => s.name).sort()).toEqual(["child", "root"]);
  });

  test("getTracesByCritique returns trace_ids matching critique_id", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = new TraceStore({ dir, dbPath: join(dir, "index.sqlite") });
    const critiqueId = "critique-abc-123";

    await store.writeSpan(makeSpan({
      trace_id: "trace1".padEnd(32, "0"),
      span_id: "sp1".padEnd(16, "0"),
      attributes: { "siltpoke.critique_id": critiqueId },
    }));
    await store.writeSpan(makeSpan({
      trace_id: "trace2".padEnd(32, "0"),
      span_id: "sp2".padEnd(16, "0"),
      attributes: { "siltpoke.critique_id": critiqueId },
    }));
    await store.writeSpan(makeSpan({
      trace_id: "trace3".padEnd(32, "0"),
      span_id: "sp3".padEnd(16, "0"),
      attributes: { "siltpoke.critique_id": "other-critique" },
    }));

    const traceIds = store.getTracesByCritique(critiqueId);
    expect(traceIds).toHaveLength(2);
    expect(traceIds).toContain("trace1".padEnd(32, "0"));
    expect(traceIds).toContain("trace2".padEnd(32, "0"));
  });

  test("getSpansByTrace returns empty array for unknown trace_id", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = new TraceStore({ dir, dbPath: join(dir, "index.sqlite") });
    const result = store.getSpansByTrace("nonexistent".padEnd(32, "0"));
    expect(result).toEqual([]);
  });
});
