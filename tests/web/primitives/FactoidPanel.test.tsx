/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { FactoidPanel } from "../../../src/web/primitives/FactoidPanel";
import { tokens } from "../../../src/web/tokens/tokens";
import type { Fact } from "../../../src/memory/memory";

const NOW = new Date("2026-05-18T14:00:00Z");

function mk(i: number): Fact {
  return {
    id: `f-${i}`,
    text: `fact ${i}`,
    source_session_id: "s",
    confidence: 0.9,
    status: i % 2 === 0 ? "active" : "pending",
    created_at: "2026-05-18T10:00:00Z",
    last_seen_at: "2026-05-18T13:00:00Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
  };
}

describe("FactoidPanel", () => {
  test("renders scroll container with max-height 280px + overflow-y auto", () => {
    const html = String(<FactoidPanel facts={[mk(1)]} now={NOW} />);
    expect(html).toContain("max-height:280px");
    expect(html).toContain("overflow-y:auto");
  });

  test("renders all rows when count <= max", () => {
    const facts = [mk(1), mk(2), mk(3)];
    const html = String(<FactoidPanel facts={facts} now={NOW} />);
    const rowCount = (html.match(/class="compact-factoid-row"/g) ?? []).length;
    expect(rowCount).toBe(3);
  });

  test("caps render at default max=10 when given 12 facts", () => {
    const facts = Array.from({ length: 12 }, (_, i) => mk(i + 1));
    const html = String(<FactoidPanel facts={facts} now={NOW} />);
    const rowCount = (html.match(/class="compact-factoid-row"/g) ?? []).length;
    expect(rowCount).toBe(10);
    expect(html).toContain("fact 1");
    expect(html).toContain("fact 10");
    expect(html).not.toContain(">fact 11<");
    expect(html).not.toContain(">fact 12<");
  });

  test("custom max prop respected (max=3, given 5)", () => {
    const facts = [mk(1), mk(2), mk(3), mk(4), mk(5)];
    const html = String(<FactoidPanel facts={facts} max={3} now={NOW} />);
    const rowCount = (html.match(/class="compact-factoid-row"/g) ?? []).length;
    expect(rowCount).toBe(3);
  });

  test("empty facts → empty state placeholder", () => {
    const html = String(<FactoidPanel facts={[]} now={NOW} />);
    expect(html).toContain("no facts yet");
    expect(html).toContain(tokens.color.ink3);
    expect(html).not.toContain("compact-factoid-row");
  });

  test("forwards now prop to each child row", () => {
    const facts = [mk(1)];
    const html = String(<FactoidPanel facts={facts} now={NOW} />);
    // mk last_seen_at is 13:00, NOW is 14:00 → "1h ago"
    expect(html).toContain("1h ago");
  });
});
