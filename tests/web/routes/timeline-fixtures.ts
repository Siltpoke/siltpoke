/**
 * Shared fixtures for the /timeline route tests (timeline.test.ts +
 * timeline-tabs.test.ts) — brain-calls.jsonl line builders (same fixture
 * shape as tests/state/critic-event-log.test.ts) and a sqlite+JSONL trace
 * seeder for the Trace-tab fragment endpoint.
 *
 * The pure line builders live in ./timeline-fixture-lines (re-exported
 * here) so the Node-run Playwright e2e fixture can import them without
 * dragging in this module's bun:sqlite dependency (TraceStore).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TraceStore } from "../../../src/observability/storage";
import type { Span } from "../../../src/observability/types";
import { type FixtureCall, fixtureLines } from "./timeline-fixture-lines";

export { type FixtureCall, fixtureLines } from "./timeline-fixture-lines";

export async function writeFixture(base: string, calls: FixtureCall[]): Promise<void> {
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "brain-calls.jsonl"), `${fixtureLines(calls).join("\n")}\n`, "utf8");
}

/**
 * Seed one linked trace (root + brain span) into the sqlite index + JSONL.
 *
 * `kinds` (default true) tags spans with `siltpoke.kind` (chain / llm) like
 * the live tracer does; `usage` (default true) adds gen_ai model+usage attrs
 * to the brain span — `usage: false` mirrors live `claude -p` brain spans,
 * which never record token usage. `io` (default false) adds the tracer's
 * `siltpoke.input` / `siltpoke.output` payload attrs to the brain span so
 * the inline span panel's Messages tab has something to show; pass an
 * object to control the exact payload strings.
 */
export async function seedTrace(
  homeBase: string,
  critiqueId: string,
  traceId: string,
  opts: { usage?: boolean; kinds?: boolean; io?: boolean | { input: string; output: string } } = {},
): Promise<void> {
  const { usage = true, kinds = true, io = false } = opts;
  await mkdir(join(homeBase, "traces"), { recursive: true });
  const store = new TraceStore({
    dbPath: join(homeBase, "traces", "index.sqlite"),
    dir: join(homeBase, "traces"),
  });
  const t0 = Date.parse("2026-07-01T10:00:00Z") * 1_000_000;
  const root: Span = {
    trace_id: traceId,
    span_id: "aaaa000000000001",
    parent_span_id: null,
    name: "siltpoke.turn",
    kind: "INTERNAL",
    start_unix_nano: t0,
    end_unix_nano: t0 + 2_000_000_000,
    status: { code: "OK" },
    attributes: {
      "siltpoke.critique_id": critiqueId,
      ...(kinds ? { "siltpoke.kind": "chain" } : {}),
    },
    events: [],
  };
  const brain: Span = {
    trace_id: traceId,
    span_id: "aaaa000000000002",
    parent_span_id: root.span_id,
    name: "siltpoke.brain.find",
    kind: "CLIENT",
    start_unix_nano: t0 + 100_000_000,
    end_unix_nano: t0 + 1_600_000_000,
    status: { code: "OK" },
    attributes: {
      "siltpoke.critique_id": critiqueId,
      ...(kinds ? { "siltpoke.kind": "llm" } : {}),
      ...(usage
        ? {
            "gen_ai.request.model": "claude-haiku-4-5",
            "gen_ai.usage.input_tokens": 1000,
            "gen_ai.usage.output_tokens": 500,
            "gen_ai.usage.cache_read_input_tokens": 400,
          }
        : {}),
      ...(io
        ? typeof io === "object"
          ? { "siltpoke.input": io.input, "siltpoke.output": io.output }
          : {
              "siltpoke.input": '"fixture prompt for the brain — check the retry loop"',
              "siltpoke.output": '"fixture brain verdict — the loop swallows aborts"',
            }
        : {}),
    },
    events: [],
  };
  await store.writeSpan(root);
  await store.writeSpan(brain);
}
