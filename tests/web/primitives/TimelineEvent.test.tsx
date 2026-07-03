/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { TimelineEvent } from "../../../src/web/primitives/TimelineEvent";
import { tokens } from "../../../src/web/tokens/tokens";

describe("TimelineEvent", () => {
  test("renders time and title", () => {
    const html = String(
      <TimelineEvent time="2h ago" title="tests passed" />,
    );
    expect(html).toContain("2h ago");
    expect(html).toContain("tests passed");
  });

  test("renders body when provided", () => {
    const html = String(
      <TimelineEvent time="2h ago" title="tests passed" body="All 1206 assertions green." />,
    );
    expect(html).toContain("All 1206 assertions green.");
  });

  test("body omitted when not provided", () => {
    const html = String(
      <TimelineEvent time="2h ago" title="tests passed" />,
    );
    // Should not contain an empty body div
    expect(html).not.toContain("font-size:12.5");
  });

  test("neutral tone uses ink3 color for dot", () => {
    const html = String(
      <TimelineEvent time="t" title="title" tone="neutral" />,
    );
    expect(html).toContain(tokens.color.ink3);
  });

  test("success tone uses moss color for dot", () => {
    const html = String(
      <TimelineEvent time="t" title="title" tone="success" />,
    );
    expect(html).toContain(tokens.color.moss);
  });

  test("warn tone uses amber color for dot", () => {
    const html = String(
      <TimelineEvent time="t" title="title" tone="warn" />,
    );
    expect(html).toContain(tokens.color.amber);
  });

  test("danger tone uses terra color for dot", () => {
    const html = String(
      <TimelineEvent time="t" title="title" tone="danger" />,
    );
    expect(html).toContain(tokens.color.terra);
  });

  test("vertical line renders when isLast is false", () => {
    const html = String(
      <TimelineEvent time="t" title="title" isLast={false} />,
    );
    // The vertical line is a div with edge background and width:1
    expect(html).toContain("width:1");
    expect(html).toContain(tokens.color.edge);
  });

  test("vertical line suppressed when isLast=true", () => {
    const html = String(
      <TimelineEvent time="t" title="title" isLast />,
    );
    // No vertical line div when isLast
    expect(html).not.toContain("width:1");
  });

  test("time uses mono font", () => {
    const html = String(
      <TimelineEvent time="Mar 14, 09:12" title="init" />,
    );
    // font-family is HTML-entity-escaped in SSR output
    expect(html).toContain("JetBrains Mono");
  });

  test("title uses bold font weight", () => {
    const html = String(
      <TimelineEvent time="t" title="init" />,
    );
    expect(html).toContain("font-weight:600");
  });
});
