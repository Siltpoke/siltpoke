/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { CompactFactoidRow, relativeAgo } from "../../../src/web/primitives/CompactFactoidRow";
import { tokens } from "../../../src/web/tokens/tokens";
import type { Fact } from "../../../src/memory/memory";

const NOW = new Date("2026-05-18T14:00:00Z");

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: "f-test-1",
    text: "test fact",
    source_session_id: "s-1",
    confidence: 0.9,
    status: "active",
    created_at: "2026-05-18T13:00:00Z",
    last_seen_at: "2026-05-18T13:30:00Z",
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
    ...over,
  };
}

describe("relativeAgo", () => {
  test("<60s → 'just now'", () => {
    expect(relativeAgo("2026-05-18T13:59:30Z", NOW)).toBe("just now");
  });

  test("30 minutes ago", () => {
    expect(relativeAgo("2026-05-18T13:30:00Z", NOW)).toBe("30m ago");
  });

  test("5 hours ago", () => {
    expect(relativeAgo("2026-05-18T09:00:00Z", NOW)).toBe("5h ago");
  });

  test("3 days ago", () => {
    expect(relativeAgo("2026-05-15T14:00:00Z", NOW)).toBe("3d ago");
  });

  test("2 weeks ago", () => {
    expect(relativeAgo("2026-05-04T14:00:00Z", NOW)).toBe("2w ago");
  });

  test("future timestamp → 'now' (no negative)", () => {
    expect(relativeAgo("2026-05-18T14:30:00Z", NOW)).toBe("now");
  });

  test("invalid timestamp → 'now'", () => {
    expect(relativeAgo("not-a-date", NOW)).toBe("now");
  });
});

describe("CompactFactoidRow", () => {
  test("renders fact text", () => {
    const html = String(<CompactFactoidRow fact={fact({ text: "remember this" })} now={NOW} />);
    expect(html).toContain("remember this");
  });

  test("active status pill uses moss color", () => {
    const html = String(<CompactFactoidRow fact={fact({ status: "active" })} now={NOW} />);
    expect(html).toContain(tokens.color.moss);
    expect(html).toContain(">active<");
  });

  test("pending status pill uses amber color", () => {
    const html = String(<CompactFactoidRow fact={fact({ status: "pending" })} now={NOW} />);
    expect(html).toContain(tokens.color.amber);
    expect(html).toContain(">pending<");
  });

  test("retired status pill uses ink3 color", () => {
    const html = String(<CompactFactoidRow fact={fact({ status: "retired" })} now={NOW} />);
    expect(html).toContain(tokens.color.ink3);
    expect(html).toContain(">retired<");
  });

  test("text container has truncation styling", () => {
    const html = String(<CompactFactoidRow fact={fact({})} now={NOW} />);
    expect(html).toContain("text-overflow:ellipsis");
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain("overflow:hidden");
  });

  test("renders relative timestamp via relativeAgo", () => {
    const f = fact({ last_seen_at: "2026-05-18T13:30:00Z" });
    const html = String(<CompactFactoidRow fact={f} now={NOW} />);
    expect(html).toContain("30m ago");
  });

  test("data-fact-id + data-fact-status attribute hooks present", () => {
    const html = String(<CompactFactoidRow fact={fact({ id: "f-abc", status: "pending" })} now={NOW} />);
    expect(html).toContain('data-fact-id="f-abc"');
    expect(html).toContain('data-fact-status="pending"');
  });
});
