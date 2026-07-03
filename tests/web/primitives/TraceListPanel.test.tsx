/** @jsxImportSource hono/jsx */
/**
 * TraceListPanel — renders cost/token columns
 */
import { describe, test, expect } from "bun:test";
import { TraceListPanel } from "../../../src/web/primitives/TraceListPanel";
import type { TraceSummary } from "../../../src/web/primitives/TraceListPanel";

function makeTrace(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    trace_id: "trace1".padEnd(32, "0"),
    name: "siltpoke.turn",
    start_unix_nano: new Date("2026-05-20T14:30:00Z").getTime() * 1_000_000,
    end_unix_nano: new Date("2026-05-20T14:30:02Z").getTime() * 1_000_000,
    day: "2026-05-20",
    critique_id: null,
    span_count: 3,
    model: "claude-haiku-4-5",
    total_input_tokens: 1000,
    total_output_tokens: 200,
    total_cached_tokens: 400,
    cache_hit_pct: 40,
    cost_usd: 0.0012,
    cache_savings_usd: 0.00036,
    ...overrides,
  };
}

describe("TraceListPanel", () => {
  test("renders empty placeholder when traces array is empty", () => {
    const html = String(<TraceListPanel traces={[]} />);
    expect(html).toContain("No traces recorded yet");
  });

  test("renders cost column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    // Column was renamed from "Cost USD" to "Cost"
    expect(html).toContain("Cost");
  });

  test("renders tokens column in some form", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    // Combined "Tokens" column replaced separate "Input tok" / "Output tok"
    expect(html).toContain("Tokens");
  });

  test("renders tokens column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    // Column was renamed from "Output tok" to "Tokens" (now combined input+output)
    expect(html).toContain("Tokens");
  });

  test("renders cached % column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Cached %");
  });

  test("renders models column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    // Column renamed from "Model" to "Models" (now shows multiple model badges)
    expect(html).toContain("Models");
  });

  test("renders critique column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Critique");
  });

  test("renders formatted token counts in combined Tokens column", () => {
    // combined: input 1000 + output 200 = 1200 → "1.2k"
    const html = String(
      <TraceListPanel
        traces={[makeTrace({ total_input_tokens: 1000, total_output_tokens: 200 })]}
      />
    );
    expect(html).toContain("1.2k");
  });

  test("renders cost value", () => {
    const html = String(<TraceListPanel traces={[makeTrace({ cost_usd: 0.0012 })]} />);
    expect(html).toContain("$0.0012");
  });

  test("renders cache hit percentage", () => {
    const html = String(<TraceListPanel traces={[makeTrace({ cache_hit_pct: 40 })]} />);
    expect(html).toContain("40%");
  });

  test("renders model name in shortened form", () => {
    const html = String(<TraceListPanel traces={[makeTrace({ model: "claude-haiku-4-5" })]} />);
    // fmtModel strips "claude-" prefix
    expect(html).toContain("haiku");
  });

  test("renders totals summary bar with turn count", () => {
    const traces = [makeTrace(), makeTrace({ trace_id: "trace2".padEnd(32, "0") })];
    const html = String(<TraceListPanel traces={traces} />);
    expect(html).toContain("Total today:");
    expect(html).toContain("2");
    expect(html).toContain("turns");
  });

  test("renders link to trace detail", () => {
    const t = makeTrace({ trace_id: "abc123".padEnd(32, "0") });
    const html = String(<TraceListPanel traces={[t]} />);
    expect(html).toContain(`/traces/${t.trace_id}`);
  });

  test("shows dash for cache % when no input tokens", () => {
    const html = String(
      <TraceListPanel traces={[makeTrace({ total_input_tokens: 0, cache_hit_pct: 0 })]} />
    );
    expect(html).toContain("—");
  });

  test("does not render phase duration column", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).not.toContain("Duration");
  });

  test("does not render root span column header 'Root span'", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).not.toContain("Root span");
  });

  // --- Step E: new columns ---

  test("renders Status column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Status");
  });

  test("renders Models column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Models");
  });

  test("renders Spans column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Spans");
  });

  test("renders Root column header", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Root");
  });

  test("renders OK status check for non-error trace", () => {
    const html = String(
      <TraceListPanel traces={[makeTrace({ status: "OK" })]} />
    );
    expect(html).toContain("✓");
  });

  test("renders error status cross for ERROR trace", () => {
    const html = String(
      <TraceListPanel traces={[makeTrace({ status: "ERROR" })]} />
    );
    expect(html).toContain("✗");
  });

  test("renders span count", () => {
    const html = String(
      <TraceListPanel traces={[makeTrace({ span_count: 7 })]} />
    );
    expect(html).toContain("7");
  });

  test("renders model badge for each model", () => {
    const html = String(
      <TraceListPanel
        traces={[
          makeTrace({
            model: "claude-haiku-4-5",
            models: ["claude-haiku-4-5", "claude-sonnet-4-5"],
          }),
        ]}
      />
    );
    expect(html).toContain("haiku");
    expect(html).toContain("sonnet");
  });

  test("renders filter dropdowns", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("All status");
    expect(html).toContain("All models");
    expect(html).toContain("Today");
  });

  test("renders filter apply button", () => {
    const html = String(<TraceListPanel traces={[makeTrace()]} />);
    expect(html).toContain("Apply");
  });

  test("shows clear link when filterStatus is active", () => {
    const html = String(
      <TraceListPanel
        traces={[makeTrace()]}
        filterStatus="ERROR"
      />
    );
    expect(html).toContain("clear");
  });

  test("renders 'no match' message when filtered traces is empty", () => {
    const html = String(
      <TraceListPanel traces={[]} filterStatus="ERROR" />
    );
    expect(html).toContain("No traces match the current filters");
  });

  test("renders combined tokens column (input + output)", () => {
    const html = String(
      <TraceListPanel
        traces={[makeTrace({ total_input_tokens: 1000, total_output_tokens: 200 })]}
      />
    );
    // 1000 + 200 = 1200 → 1.2k
    expect(html).toContain("1.2k");
  });

  test("renders available models in model dropdown", () => {
    const html = String(
      <TraceListPanel
        traces={[makeTrace()]}
        availableModels={["claude-haiku-4-5", "claude-sonnet-4-5"]}
      />
    );
    expect(html).toContain("haiku");
    expect(html).toContain("sonnet");
  });
});
